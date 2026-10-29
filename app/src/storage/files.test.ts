import { expoFileSystemPort } from './files';

// Model the native boundary: SDK 58 write() completes asynchronously, while
// writeSync() makes bytes visible before returning. The port promises the latter.
jest.mock('expo-file-system', () => {
  const files = new Map<string, Uint8Array>();
  class File {
    readonly uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return files.has(this.uri); }
    create() { files.set(this.uri, new Uint8Array()); }
    bytesSync() { return files.get(this.uri)!; }
    writeSync(contents: string | Uint8Array, options?: { encoding?: string }) {
      if (this.uri.includes('read-only')) throw new Error('write denied');
      files.set(this.uri, typeof contents === 'string'
        ? new Uint8Array(Buffer.from(contents, options?.encoding === 'base64' ? 'base64' : 'utf8'))
        : contents.slice());
    }
    async write(contents: string | Uint8Array, options?: { encoding?: string }) {
      await Promise.resolve();
      this.writeSync(contents, options);
    }
  }
  return { File, Directory: class {}, Paths: { document: { uri: 'file:///documents' } } };
});

it('makes UTF-8 text available before writeFile returns', () => {
  const path = 'file:///text';
  expoFileSystemPort.writeFile(path, '画像');
  expect(Buffer.from(expoFileSystemPort.readBytes(path)).toString('utf8')).toBe('画像');
});

it('decodes base64 bytes before writeFile returns', () => {
  const path = 'file:///base64';
  expoFileSystemPort.writeFile(path, 'AAH/', 'base64');
  expect([...expoFileSystemPort.readBytes(path)]).toEqual([0, 1, 255]);
});

it('makes raw bytes available before writeBytes returns', () => {
  const path = 'file:///bytes';
  expoFileSystemPort.writeBytes(path, new Uint8Array([0, 127, 255]));
  expect([...expoFileSystemPort.readBytes(path)]).toEqual([0, 127, 255]);
});

it('propagates synchronous write failures to the caller', () => {
  expect(() => expoFileSystemPort.writeFile('file:///read-only-text', 'value')).toThrow('write denied');
  expect(() => expoFileSystemPort.writeBytes('file:///read-only-bytes', new Uint8Array([1]))).toThrow('write denied');
});
