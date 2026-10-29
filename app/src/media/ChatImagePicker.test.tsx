import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { openAppDatabase, type AppStorage } from '../storage/database';
import { readChatDraft, saveChatDraft } from '../storage/chat';
import { createImageStore, type FileSystemPort, type ImageStore } from '../storage/files';
import { createNodeFileSystemPort, NodeSqliteDriver } from '../storage/testSupport/nodePorts';
import { ThemeProvider } from '../theme/provider';
import { ChatImagePicker, createDeviceChatImageOps } from './ChatImagePicker';
import { PROBE_TRANSPARENT_PNG_BASE64 } from './avatarProbeFixtures';
import type { ChatImageOps } from './chatImages';
import type { ChatDraft } from '../messages/types';

let mockPick: jest.Mock;
let mockManipulate: jest.Mock;
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator:{ manipulate:(...args:unknown[]) => mockManipulate(...args) },SaveFormat:{ PNG:'png',JPEG:'jpeg' },
}));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync:(...args:unknown[]) => mockPick(...args),
  UIImagePickerPreferredAssetRepresentationMode:{ Current:'current' },
}));
let root:string, db:AppStorage, disk:FileSystemPort, images:ImageStore, uri:string, seq:number;
let ops:ChatImageOps, changes:ChatDraft[];
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(),'chat-picker-')); seq = 0; changes = [];
  disk = createNodeFileSystemPort(path.join(root,'documents'));
  db = await openAppDatabase({ driver:new NodeSqliteDriver(path.join(root,'app.db')) });
  images = createImageStore({ fs:disk,newId:() => `picker-${++seq}` });
  uri = path.join(root,'picked.png'); fs.writeFileSync(uri,Buffer.from(PROBE_TRANSPARENT_PNG_BASE64,'base64'));
  ops = { decode:async uri => ({ uri,width:1600,height:1200 }),encode:async () => {
    const output = path.join(root,`encoded-${++seq}.png`); fs.copyFileSync(uri,output);
    return { uri:output,width:1600,height:1200 };
  } };
  mockPick = jest.fn().mockResolvedValue({ canceled:false,assets:[{ uri,mimeType:'image/png',type:'image' }] });
  await saveChatDraft(db,{ accountId:'alice',peerId:'bob',body:'本文',attachments:[],updatedAt:1 });
});
afterEach(async () => { await db.close(); fs.rmSync(root,{ recursive:true,force:true }); });
const component = (peerId = 'bob') => <ThemeProvider><ChatImagePicker accountId="alice" peerId={peerId}
  db={db} fs={disk} store={images} ops={ops} onChange={draft => changes.push(draft)} /></ThemeProvider>;
async function ready() {
  const view = await render(component());
  await waitFor(() => expect(view.getByRole('button',{ name:'ライブラリから画像を追加' }).props.accessibilityState.disabled).toBe(false));
  return view;
}
it('uses only the library without cropping and previews/removes durable drafts accessibly', async () => {
  const view = await ready();
  await fireEvent.press(view.getByRole('button',{ name:'ライブラリから画像を追加' }));
  await waitFor(() => expect(view.getByRole('image',{ name:'添付画像 1' })).toBeTruthy());
  expect(mockPick).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes:['images'],allowsEditing:false,
    allowsMultipleSelection:true,selectionLimit:4,quality:1,preferredAssetRepresentationMode:'current' }));
  const draft = await readChatDraft(db,'alice','bob');
  expect(draft?.body).toBe('本文'); expect(changes).toHaveLength(1);
  expect(view.getByRole('image',{ name:'添付画像 1' }).props.source.uri).toBe(images.resolvePath(draft!.attachments[0]));
  await fireEvent.press(view.getByRole('button',{ name:'添付画像 1を解除' }));
  await waitFor(() => expect(view.queryByRole('image')).toBeNull());
  expect((await readChatDraft(db,'alice','bob'))?.attachments).toEqual([]);
});
it('cancel keeps the existing preview, draft and callback count unchanged', async () => {
  const image = await images.importImage('alice',uri);
  await saveChatDraft(db,{ accountId:'alice',peerId:'bob',body:'本文',attachments:[image],updatedAt:1 });
  mockPick.mockResolvedValue({ canceled:true,assets:null });
  const view = await ready(), old = await readChatDraft(db,'alice','bob');
  await fireEvent.press(view.getByRole('button',{ name:'ライブラリから画像を追加' }));
  await waitFor(() => expect(mockPick).toHaveBeenCalledTimes(1));
  expect(await readChatDraft(db,'alice','bob')).toEqual(old); expect(changes).toEqual([]);
  expect(view.getByRole('image',{ name:'添付画像 1' })).toBeTruthy();
});
it('shows a persistent actionable error and keeps previous input when processing fails', async () => {
  ops.encode = async () => { throw new Error('native error with private URI'); };
  const view = await ready(), old = await readChatDraft(db,'alice','bob');
  await fireEvent.press(view.getByRole('button',{ name:'ライブラリから画像を追加' }));
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
  expect(await readChatDraft(db,'alice','bob')).toEqual(old); expect(changes).toEqual([]);
  expect(view.queryByText(/private URI/)).toBeNull();
});
it('does not apply a library result to the old peer after the scope unmounts', async () => {
  let finish!:(value:unknown) => void;
  mockPick.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = await ready();
  await fireEvent.press(view.getByRole('button',{ name:'ライブラリから画像を追加' }));
  await view.rerender(component('carol'));
  await act(async () => { finish({ canceled:false,assets:[{ uri }] }); });
  expect((await readChatDraft(db,'alice','bob'))?.attachments).toEqual([]);
  expect(await readChatDraft(db,'alice','carol')).toBeNull(); expect(changes).toEqual([]);
});
it('disables adding at four, and serializes a pending library interaction', async () => {
  let finish!:(value:unknown) => void;
  mockPick.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = await ready();
  await fireEvent.press(view.getByRole('button',{ name:'ライブラリから画像を追加' }));
  await fireEvent.press(view.getByRole('button',{ name:'ライブラリから画像を追加' }));
  expect(mockPick).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ canceled:false,assets:Array(4).fill({ uri }) }); });
  await waitFor(() => expect(view.getAllByRole('image')).toHaveLength(4));
  expect(view.getByRole('button',{ name:'ライブラリから画像を追加' }).props.accessibilityState.disabled).toBe(true);
});
it('device adapter decodes first, resizes without a crop, passes quality and releases native refs', async () => {
  const calls:unknown[] = [];
  const releaseImage = jest.fn(), releaseContext = jest.fn(), resize = jest.fn();
  mockManipulate = jest.fn(uri => {
    calls.push(uri);
    return { resize,release:releaseContext,renderAsync:async () => ({
      width:240,height:320,release:releaseImage,
      saveAsync:async (options:unknown) => { calls.push(options); return { uri:'oriented.png' }; },
    }) };
  });
  const native = createDeviceChatImageOps();
  const decoded = await native.decode('original.heic');
  expect(decoded).toEqual({ uri:'oriented.png',width:240,height:320 }); expect(resize).not.toHaveBeenCalled();
  await native.encode(decoded,{ width:120,height:160 },'jpeg',0.8);
  expect(resize).toHaveBeenCalledWith({ width:120,height:160 });
  expect(calls).toEqual(['original.heic',{ format:'png',compress:1 },'oriented.png',{ format:'jpeg',compress:0.8 }]);
  expect(releaseImage).toHaveBeenCalledTimes(2); expect(releaseContext).toHaveBeenCalledTimes(2);
});
