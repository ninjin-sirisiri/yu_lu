import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { ChatMessagesResult } from '../src/backend/chat';
import type { AppearancePresetId } from '../src/appearance/contracts';
import { ChatAppearancePicker } from '../src/appearance/ChatAppearancePicker';
import type { PendingAppearanceCommand, SharedAppearanceOutcome } from '../src/appearance/sharedSettings';
import { ChatProvider, type ChatState, type ChatStore } from '../src/messages/provider';
import { A, B, E, page } from '../src/messages/repositoryTestSupport';
import { ThemeProvider } from '../src/theme/provider';

const themeStore = { read: async () => null, write: async () => {} };

function confirmed(selected: AppearancePresetId | null, canChange = true): ChatMessagesResult {
  return page(undefined, {
    appearance: {
      growth_days: 3,
      auto_preset_id: 'b-pop',
      selected_preset_id: selected,
      effective_preset_id: selected ?? 'b-pop',
      catalog_version: 1,
      settings_revision: 4,
      can_change: canChange,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function pendingRecord(overrides: Partial<PendingAppearanceCommand> = {}): PendingAppearanceCommand {
  return {
    operationId: '11111111-1111-4111-8111-111111111111',
    peerId: B,
    friendshipEpoch: E,
    presetId: 'b-candy',
    state: 'unknown',
    createdAt: 1,
    ...overrides,
  };
}

interface FakeController {
  pending: jest.Mock;
  apply: jest.Mock;
  confirm: jest.Mock;
}

function fakeStore(sharedAppearance: FakeController): ChatStore {
  const state: ChatState = {
    accountId: A,
    activePeerId: B,
    foreground: true,
    connected: true,
    home: null,
    conversation: null,
    drafts: {},
    pendingReadSync: false,
    refreshPending: false,
    error: null,
    stopped: false,
    arrival: null,
  };
  const store = {
    ...state,
    accountId: A,
    session: { active: async () => true } as unknown as ChatStore['session'],
    getSnapshot: () => state,
    subscribe: () => () => {},
    start() {},
    stop() {},
    sharedAppearance,
  } as unknown as ChatStore;
  return store;
}

async function renderPicker(
  store: ChatStore,
  props: Partial<React.ComponentProps<typeof ChatAppearancePicker>> = {},
) {
  const factory = () => store;
  const element = (overrides: Partial<React.ComponentProps<typeof ChatAppearancePicker>> = {}) => (
    <ThemeProvider store={themeStore} deviceScheme="light">
      <ChatProvider createStore={factory}>
        <ChatAppearancePicker
          peerId={B}
          metadata={confirmed(null)}
          active
          onClose={jest.fn()}
          onRefetch={jest.fn(async () => true)}
          {...props}
          {...overrides}
        />
      </ChatProvider>
    </ThemeProvider>
  );
  const view = await render(element());
  return {
    view,
    rerender: async (overrides: Partial<React.ComponentProps<typeof ChatAppearancePicker>> = {}) => {
      await view.rerender(element(overrides));
    },
  };
}

function controller(overrides: Partial<FakeController> = {}): FakeController {
  return {
    pending: jest.fn(async () => null),
    apply: jest.fn(async () => ({ status: 'applied' as const, pending: null })),
    confirm: jest.fn(async () => ({ status: 'applied' as const, pending: null })),
    ...overrides,
  };
}

it('browses samples without sending and only sends on explicit apply', async () => {
  const shared = controller();
  const onRefetch = jest.fn(async () => true);
  await renderPicker(fakeStore(shared), { onRefetch });

  await fireEvent.press(screen.getByTestId('appearance-sample-b-candy'));

  expect(shared.apply).not.toHaveBeenCalled();
  expect(shared.confirm).not.toHaveBeenCalled();
  expect(screen.getByTestId('appearance-sample-b-candy').props.accessibilityState.selected).toBe(true);

  await fireEvent.press(screen.getByTestId('appearance-apply'));

  await waitFor(() => expect(shared.apply).toHaveBeenCalledTimes(1));
  expect(shared.apply).toHaveBeenCalledWith(expect.objectContaining({
    peerId: B,
    friendshipEpoch: E,
    presetId: 'b-candy',
    isCurrent: expect.any(Function),
  }));
  await waitFor(() => expect(onRefetch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(false));
});

it('does not assign the command response locally and shows success only after the confirmed query is refetched', async () => {
  const shared = controller();
  const refetch = deferred<unknown>();
  const onRefetch = jest.fn(() => refetch.promise);
  const picker = await renderPicker(fakeStore(shared), { onRefetch });

  await fireEvent.press(screen.getByTestId('appearance-sample-b-candy'));
  await fireEvent.press(screen.getByTestId('appearance-apply'));

  await waitFor(() => expect(onRefetch).toHaveBeenCalledTimes(1));
  expect(screen.getByText(/最後の確定設定: ポップ大騒ぎ/)).toBeTruthy();
  expect(screen.queryByText('2人の設定に反映しました')).toBeNull();
  expect(screen.getByText('変更を確認しています…')).toBeTruthy();

  await picker.rerender({ metadata: confirmed('b-candy') });
  await act(async () => { refetch.resolve(true); });

  expect(await screen.findByText('2人の設定に反映しました')).toBeTruthy();
  expect(screen.getByText(/最後の確定設定: キャンディ/)).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(false));
});

it('returns to automatic with an explicit null preset', async () => {
  const shared = controller();
  const onRefetch = jest.fn(async () => true);
  await renderPicker(fakeStore(shared), { metadata: confirmed('b-candy'), onRefetch });

  await fireEvent.press(screen.getByTestId('appearance-auto'));

  await waitFor(() => expect(shared.apply).toHaveBeenCalledWith(expect.objectContaining({
    peerId: B,
    friendshipEpoch: E,
    presetId: null,
  })));
  await waitFor(() => expect(onRefetch).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('2人の設定に反映しました')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(false));
});

it('explains an offline outcome without refetching', async () => {
  const shared = controller({ apply: jest.fn(async () => ({
    status: 'offline' as const,
    message: 'オフラインのため変更できません。接続が戻ってからお試しください。',
    pending: null,
  })) });
  const onRefetch = jest.fn(async () => true);
  await renderPicker(fakeStore(shared), { onRefetch });

  await fireEvent.press(screen.getByTestId('appearance-sample-b-candy'));
  await fireEvent.press(screen.getByTestId('appearance-apply'));

  expect(await screen.findByText(/オフラインのため変更できません/)).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(false));
  expect(onRefetch).not.toHaveBeenCalled();
});

it('explains a rejected outcome', async () => {
  const shared = controller({ apply: jest.fn(async () => ({
    status: 'rejected' as const,
    message: 'この関係では変更できません。',
    pending: null,
  })) });
  await renderPicker(fakeStore(shared));

  await fireEvent.press(screen.getByTestId('appearance-sample-b-candy'));
  await fireEvent.press(screen.getByTestId('appearance-apply'));

  expect(await screen.findByText('この関係では変更できません。')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(false));
});

it('keeps an unknown result unresolved, blocks a new apply, and confirms the same operation', async () => {
  const record = pendingRecord();
  const confirm = jest.fn(async () => ({ status: 'applied' as const, pending: null }));
  const unknown = controller({
    apply: jest.fn(async () => ({ status: 'unknown' as const, pending: record })),
    confirm,
  });
  const onRefetch = jest.fn(async () => true);
  await renderPicker(fakeStore(unknown), { onRefetch });

  await fireEvent.press(screen.getByTestId('appearance-sample-b-candy'));
  await fireEvent.press(screen.getByTestId('appearance-apply'));

  expect(await screen.findByText('結果を確認')).toBeTruthy();
  expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByText(/結果を確認できていません/)).toBeTruthy();

  await fireEvent.press(screen.getByTestId('appearance-sample-b-soda'));
  expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(true);
  expect(unknown.apply).toHaveBeenCalledTimes(1);

  await fireEvent.press(screen.getByText('結果を確認'));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith(B, expect.objectContaining({ isCurrent: expect.any(Function) })));
  await waitFor(() => expect(onRefetch).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('2人の設定に反映しました')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(false));
});

it('shows a persisted pending command after reopening and can confirm it', async () => {
  const record = pendingRecord();
  const onRefetch = jest.fn(async () => true);
  const confirm = jest.fn(async () => ({ status: 'applied' as const, pending: null }));
  const shared = controller({ pending: jest.fn(async () => record), confirm });
  await renderPicker(fakeStore(shared), { onRefetch });

  expect(await screen.findByText('結果を確認')).toBeTruthy();
  expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(true);

  await fireEvent.press(screen.getByText('結果を確認'));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(onRefetch).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('2人の設定に反映しました')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(false));
});

it('does not dispatch twice on a double press', async () => {
  const gate = deferred<SharedAppearanceOutcome>();
  const shared = controller({ apply: jest.fn(() => gate.promise) });
  await renderPicker(fakeStore(shared));

  await fireEvent.press(screen.getByTestId('appearance-sample-b-candy'));
  const applyButton = screen.getByTestId('appearance-apply');
  await fireEvent.press(applyButton);
  await fireEvent.press(applyButton);

  await waitFor(() => expect(shared.apply).toHaveBeenCalledTimes(1));
  await act(async () => { gate.resolve({ status: 'applied', pending: null }); });
  expect(await screen.findByText('2人の設定に反映しました')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(false));
  expect(shared.apply).toHaveBeenCalledTimes(1);
});

it('is view-only when the relationship can no longer change the shared setting', async () => {
  const shared = controller();
  await renderPicker(fakeStore(shared), { metadata: confirmed('b-pop', false) });

  expect(screen.getByText(/この関係では見た目を変更できません/)).toBeTruthy();
  expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('appearance-auto').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('appearance-sample-b-candy').props.accessibilityState.disabled).toBe(true);

  await fireEvent.press(screen.getByTestId('appearance-sample-b-candy'));
  await fireEvent.press(screen.getByTestId('appearance-apply'));
  expect(shared.apply).not.toHaveBeenCalled();
});

it('ignores a response that arrives after the picker is no longer active', async () => {
  const gate = deferred<SharedAppearanceOutcome>();
  const shared = controller({ apply: jest.fn(() => gate.promise) });
  const onRefetch = jest.fn(async () => true);
  const picker = await renderPicker(fakeStore(shared), { onRefetch });

  await fireEvent.press(screen.getByTestId('appearance-sample-b-candy'));
  await fireEvent.press(screen.getByTestId('appearance-apply'));
  await waitFor(() => expect(shared.apply).toHaveBeenCalledTimes(1));

  await picker.rerender({ active: false });
  await act(async () => { gate.resolve({ status: 'applied', pending: null }); });

  expect(onRefetch).not.toHaveBeenCalled();
  expect(screen.queryByText('2人の設定に反映しました')).toBeNull();
});

it('ignores a response that arrives after the picker unmounts', async () => {
  const gate = deferred<SharedAppearanceOutcome>();
  const shared = controller({ apply: jest.fn(() => gate.promise) });
  const onRefetch = jest.fn(async () => true);
  const picker = await renderPicker(fakeStore(shared), { onRefetch });

  await fireEvent.press(screen.getByTestId('appearance-sample-b-candy'));
  await fireEvent.press(screen.getByTestId('appearance-apply'));
  await waitFor(() => expect(shared.apply).toHaveBeenCalledTimes(1));

  await picker.view.unmount();
  await act(async () => { gate.resolve({ status: 'applied', pending: null }); });

  expect(onRefetch).not.toHaveBeenCalled();
});

it('does not invent a confirmed preset while the appearance is unavailable', async () => {
  const shared = controller();
  await renderPicker(fakeStore(shared), { metadata: page(undefined, { appearance: undefined }) });

  expect(screen.getByText(/見た目を確認中/)).toBeTruthy();
  expect(screen.queryByText(/最後の確定設定/)).toBeNull();
  expect(screen.queryByText(/自動に戻すと/)).toBeNull();
  expect(screen.getByTestId('appearance-apply').props.accessibilityState.disabled).toBe(true);
});
