import { Bell, BellOff, Volume2, VolumeX, X } from "lucide-react";
import { useNotificationStore } from "../stores/notificationStore";

/** Banner prompting the user to enable browser notifications. */
export function NotificationPermissionBanner() {
  const permission = useNotificationStore((s) => s.permission);
  const bannerDismissed = useNotificationStore((s) => s.bannerDismissed);
  const requestPermission = useNotificationStore((s) => s.requestPermission);
  const dismissBanner = useNotificationStore((s) => s.dismissBanner);

  // Only show if permission hasn't been asked yet and banner wasn't dismissed
  if (permission !== "default" || bannerDismissed) return null;

  return (
    <div className="flex items-center gap-2 border-b border-status-warning/30 bg-status-warning/5 px-3 py-1.5">
      <Bell className="h-3.5 w-3.5 shrink-0 text-status-warning" />
      <p className="flex-1 text-[11px] text-ink-secondary">
        Enable notifications to get alerted about agent approval requests
      </p>
      <button
        type="button"
        onClick={() => void requestPermission()}
        className="rounded-sm bg-accent-strong px-2 py-0.5 text-[11px] font-medium text-white transition hover:bg-accent"
      >
        Enable
      </button>
      <button
        type="button"
        onClick={dismissBanner}
        className="text-ink-muted transition hover:text-ink"
        title="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Floating banner showing pending approval count with link to view. */
export function PendingApprovalBanner({ onView }: { onView?: () => void }) {
  const pendingCount = useNotificationStore((s) => s.pendingCount);

  if (pendingCount === 0) return null;

  return (
    <div className="flex items-center gap-2 border-b border-status-warning/30 bg-status-warning/5 px-3 py-1.5">
      <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-status-warning text-[10px] font-bold text-white">
        {pendingCount}
      </span>
      <p className="flex-1 text-[11px] text-ink-secondary">
        {pendingCount === 1 ? "1 pending approval" : `${pendingCount} pending approvals`}
      </p>
      {onView && (
        <button
          type="button"
          onClick={onView}
          className="rounded-sm border border-status-warning/30 bg-status-warning/10 px-2 py-0.5 text-[11px] font-medium text-status-warning transition hover:bg-status-warning/20"
        >
          View
        </button>
      )}
    </div>
  );
}

/** Sound toggle button for use in StatusBar or settings. */
export function SoundToggle() {
  const soundEnabled = useNotificationStore((s) => s.soundEnabled);
  const toggleSound = useNotificationStore((s) => s.toggleSound);

  return (
    <button
      type="button"
      onClick={toggleSound}
      className="inline-flex items-center gap-1 text-ink-muted transition hover:text-ink"
      title={soundEnabled ? "Mute notification sounds" : "Unmute notification sounds"}
    >
      {soundEnabled ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
    </button>
  );
}

/** Notification indicator for StatusBar: shows bell icon with count badge when there are pending approvals. */
export function NotificationIndicator() {
  const pendingCount = useNotificationStore((s) => s.pendingCount);
  const permission = useNotificationStore((s) => s.permission);

  if (pendingCount === 0 && permission === "granted") return null;

  return (
    <div className="flex items-center gap-1.5">
      {pendingCount > 0 && (
        <span className="inline-flex items-center gap-1 text-status-warning">
          <Bell className="h-3 w-3" />
          <span className="text-[11px] font-medium">{pendingCount}</span>
        </span>
      )}
      {permission === "denied" && (
        <span className="text-ink-muted" title="Browser notifications blocked">
          <BellOff className="h-3 w-3" />
        </span>
      )}
    </div>
  );
}
