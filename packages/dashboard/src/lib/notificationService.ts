let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  try {
    audioCtx = new AudioContext();
    return audioCtx;
  } catch {
    return null;
  }
}

/**
 * Play two short beeps using the Web Audio API.
 * No audio files needed — generates a sine wave tone.
 */
export function playNotificationSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Resume if suspended (required after user gesture on mobile)
  if (ctx.state === "suspended") {
    void ctx.resume();
  }

  const now = ctx.currentTime;

  for (let i = 0; i < 2; i++) {
    const start = now + i * 0.18;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = 880; // A5
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.15, start + 0.02);
    gain.gain.linearRampToValueAtTime(0, start + 0.1);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.12);
  }
}

const REQUEST_TYPE_LABELS: Record<string, string> = {
  command_execution_approval: "Run Command",
  file_read_approval: "Read File",
  file_change_approval: "Edit File",
  tool_user_input: "User Input Required",
};

function humanRequestType(raw: string): string {
  return REQUEST_TYPE_LABELS[raw] ?? "Approval Required";
}

// SVG icon as a data URL for the notification icon
const NOTIFICATION_ICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">' +
  '<rect width="64" height="64" rx="12" fill="%23f59e0b"/>' +
  '<path d="M32 16c-1.1 0-2 .9-2 2v1.1C24.4 20.4 20 25.5 20 31.5V39l-3.3 3.3c-.6.6-.2 1.7.7 1.7h29.2c.9 0 1.3-1.1.7-1.7L44 39v-7.5c0-6-4.4-11.1-10-12.4V18c0-1.1-.9-2-2-2zm-3 32a3 3 0 0 0 6 0" fill="white"/>' +
  '</svg>'
);

/**
 * Send a browser notification for an approval request.
 * Only fires when the page is hidden (user is in another tab/app).
 */
export function sendApprovalNotification(opts: {
  requestId: string;
  requestType: string;
  detail?: string;
  sessionTitle?: string;
  sessionId: string;
}): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!document.hidden) return;

  const typeLabel = humanRequestType(opts.requestType);
  const bodyParts: string[] = [];
  if (opts.detail) bodyParts.push(opts.detail);
  if (opts.sessionTitle) bodyParts.push(`Session: ${opts.sessionTitle}`);
  else bodyParts.push(`Session: ${opts.sessionId}`);

  const body = bodyParts.join(" \u2014 "); // em dash separator

  const notification = new Notification("Agent needs approval", {
    body: `${typeLabel}: ${body}`,
    icon: NOTIFICATION_ICON,
    tag: opts.requestId, // prevents duplicate notifications for same request
  });

  notification.onclick = () => {
    window.focus();
    // Navigate to the session
    window.location.hash = `#session=${opts.sessionId}`;
    notification.close();
  };
}

const BASE_TITLE = "orka";
let originalTitle = BASE_TITLE;

/** Capture the original page title (call once on init). */
export function captureBaseTitle(): void {
  // Strip any existing badge from the title
  const clean = document.title.replace(/^\(\d+\)\s*/, "");
  originalTitle = clean || BASE_TITLE;
}

/** Update the browser tab title to show a badge count. */
export function updateTitleBadge(count: number): void {
  document.title = count > 0 ? `(${count}) ${originalTitle}` : originalTitle;
}
