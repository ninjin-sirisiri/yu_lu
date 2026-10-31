import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect, useState } from 'react';
import { createCaptureController, parseCaptureCommand } from './devCapture';
import { devPreviewAvailable, getDevPreview, setDevPreview } from './devPreview';

export function DevCaptureObserver() {
  const path = usePathname();
  const { capturePreview, captureDays, captureReset } = useGlobalSearchParams();
  const [controller] = useState(() => createCaptureController({ get: getDevPreview, set: setDevPreview }));
  useEffect(() => {
    const command = parseCaptureCommand(path, { capturePreview, captureDays, captureReset }, devPreviewAvailable());
    if (command) controller.apply(command);
  }, [path, capturePreview, captureDays, captureReset, controller]);
  useEffect(() => () => controller.apply({ kind: 'restore' }), [controller]);
  return null;
}
