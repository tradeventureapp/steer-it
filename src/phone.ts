import { supabase, channelName } from './supabase';

// ---------- Read session code ----------
const params = new URLSearchParams(window.location.search);
const code = (params.get('s') || '').toUpperCase();

const unlockBtn = document.getElementById('unlock') as HTMLButtonElement;
const steeringEl = document.getElementById('steering') as HTMLDivElement;
const errorEl = document.getElementById('error') as HTMLDivElement;

if (!code) {
  showError('No session code in URL. Scan the QR code on the desktop screen.');
}

// ---------- Channel ----------
const channel = supabase.channel(channelName(code), {
  config: { broadcast: { self: false } },
});
channel.subscribe();

// ---------- Unlock + tilt ----------
unlockBtn.addEventListener('click', async () => {
  try {
    const DOE = (window as unknown as {
      DeviceOrientationEvent?: { requestPermission?: () => Promise<PermissionState | 'granted' | 'denied'> };
    }).DeviceOrientationEvent;

    // iOS Safari requires an explicit user-gesture permission request.
    if (DOE && typeof DOE.requestPermission === 'function') {
      const result = await DOE.requestPermission();
      if (result !== 'granted') {
        showError('Motion permission denied. Reload the page and tap again.');
        return;
      }
    }
    startSteering();
  } catch (err) {
    showError('Could not enable motion: ' + (err as Error).message);
  }
});

function startSteering() {
  unlockBtn.hidden = true;
  steeringEl.hidden = false;

  let latestGamma = 0;
  let hasReading = false;

  // Listen at the native event rate; we only buffer the most recent value.
  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma == null) return;
    latestGamma = e.gamma;
    hasReading = true;
  });

  // Throttle broadcasts to ~30/s. The desktop interpolates between samples.
  const INTERVAL_MS = 1000 / 30;
  setInterval(() => {
    if (!hasReading) return;
    channel.send({
      type: 'broadcast',
      event: 'tilt',
      payload: { gamma: latestGamma },
    });
  }, INTERVAL_MS);
}

function showError(msg: string) {
  errorEl.hidden = false;
  errorEl.textContent = msg;
  unlockBtn.hidden = true;
  steeringEl.hidden = true;
}
