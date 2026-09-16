export const APP_SCHEME = 'bpmz';

export const VIEWPORT =
  'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function publicOrigin(req: { protocol: string; get: (h: string) => string | undefined }): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host') ?? 'bipmusic.ru'}`;
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const PREVIEW_STYLE = `<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; scrollbar-width: none; -ms-overflow-style: none; }
  *::-webkit-scrollbar { display: none; width: 0; height: 0; }
  html, body {
    margin: 0; height: 100%; background: #090a0f; color: #f7f8fa;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow: hidden; overscroll-behavior: none; touch-action: manipulation;
    -webkit-text-size-adjust: 100%; -webkit-user-select: none; user-select: none;
  }
  .bg {
    position: fixed; inset: 0; background-size: cover; background-position: center;
    filter: blur(48px) saturate(.65); opacity: .35; pointer-events: none;
  }
  .veil {
    position: fixed; inset: 0; pointer-events: none;
    background: linear-gradient(180deg, rgba(9,10,15,.25) 0%, #090a0f 62%);
  }
  .page {
    position: relative; z-index: 1; height: 100%; overflow: auto;
    overscroll-behavior: none; -webkit-overflow-scrolling: touch;
    max-width: 520px; margin: 0 auto; padding: 28px 20px 36px;
  }
  .hero { display: flex; gap: 16px; align-items: flex-end; margin-bottom: 22px; }
  .cover {
    width: 112px; height: 112px; border-radius: 10px; object-fit: cover; flex: none;
    background: #17181f;
  }
  .cover--empty { display: grid; place-items: center; font-size: 36px; }
  .meta { min-width: 0; padding-bottom: 2px; }
  h1 { margin: 0 0 4px; font-size: 22px; line-height: 1.2; letter-spacing: -.3px; font-weight: 700; }
  .sub { margin: 0 0 2px; font-size: 15px; color: #c5c8d0; }
  .stats { margin: 0; font-size: 13px; color: #8b909a; }
  .tracks { margin: 0; padding: 0; list-style: none; }
  .tracks li {
    display: flex; align-items: baseline; gap: 12px; padding: 11px 0;
    border-bottom: 1px solid rgba(255,255,255,.06);
  }
  .tracks li:last-child { border-bottom: 0; }
  .num { width: 18px; font-size: 13px; color: #5c5c66; font-variant-numeric: tabular-nums; text-align: right; flex: none; }
  .t { min-width: 0; flex: 1; }
  .t b { display: block; font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .t span { display: block; font-size: 12px; color: #8b909a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dur { font-size: 12px; color: #5c5c66; font-variant-numeric: tabular-nums; flex: none; }
  .open {
    display: block; margin: 24px 0 0; padding: 14px 20px; border-radius: 12px; text-align: center;
    background: #34d399; color: #10231c; font-size: 16px; font-weight: 600; text-decoration: none;
  }
  @media (min-width: 800px) {
    .page {
      max-width: 860px; padding: 48px 40px;
      display: grid; grid-template-columns: 240px minmax(0, 1fr); column-gap: 48px;
      align-content: start; grid-template-rows: auto auto 1fr;
    }
    .hero { grid-column: 1; flex-direction: column; align-items: stretch; margin: 0; gap: 18px; }
    .cover { width: 240px; height: 240px; border-radius: 12px; }
    .tracks { grid-column: 2; grid-row: 1 / span 3; margin: 0; overflow: auto; max-height: calc(100vh - 96px); overscroll-behavior: none; }
    .open { grid-column: 1; margin-top: 20px; }
  }
  @media (max-width: 420px) {
    .page { padding: 20px 16px 28px; }
    .cover { width: 88px; height: 88px; }
    h1 { font-size: 19px; }
  }
</style>`;

export function trackRows(
  tracks: Array<{ title: string; duration: number; artist?: string | null }>
): string {
  if (!tracks.length) return '';
  return `<ol class="tracks">${tracks
    .map(
      (t, i) => `<li>
      <span class="num">${i + 1}</span>
      <div class="t"><b>${escapeHtml(t.title)}</b>${t.artist ? `<span>${escapeHtml(t.artist)}</span>` : ''}</div>
      <span class="dur">${mmss(t.duration)}</span>
    </li>`
    )
    .join('')}</ol>`;
}

export const LOCK_SCRIPT = `<script>
addEventListener('gesturestart',function(e){e.preventDefault()});
addEventListener('gesturechange',function(e){e.preventDefault()});
</script>`;

