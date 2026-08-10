import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  RegisteredChildDetector,
  SubagentDetector,
} from "./authority/subagent-detection";
import { emitReadyEvent, type PermissionEventBus } from "./permission-events";
import {
  type PermissionConfigService,
  type PermissionsService,
  publishPermissionConfigService,
  publishPermissionsService,
  unpublishPermissionConfigService,
  unpublishPermissionsService,
} from "./service";

/** The session-scoped service lifecycle that the lifecycle handler drives. */
export interface ServiceLifecycle {
  activate(ctx: ExtensionContext): void;
  teardown(): void;
}

/**
 * Owns the process-global service publication lifecycle for one extension
 * instance.
 *
 * - `activate` publishes both the permissions service and the config service
 *   (skipped for registered subagent children so they never clobber the
 *   parent's slots — see #302), then emits the ready event.
 * - `teardown` runs all session-scoped subscription cleanups in order, then
 *   unpublishes both services.
 */
export class PermissionServiceLifecycle implements ServiceLifecycle {
  constructor(
    private readonly service: PermissionsService,
    private readonly configService: PermissionConfigService,
    private readonly detection: RegisteredChildDetector & SubagentDetector,
    private readonly onSubagentContextChange: (isSubagent: boolean) => void,
    private readonly events: PermissionEventBus,
    private readonly subscriptions: readonly (() => void)[],
  ) {}

  activate(ctx: ExtensionContext): void {
    // Anchor the per-session subagent-context flag the PermissionManager's
    // isSubagent() thunk reads, so the subagentPermission default layer is
    // composed (or not) for this session's check(). Detection needs the
    // session id, which is only available at session_start — hence here.
    this.onSubagentContextChange(this.detection.isSubagent(ctx));
    if (!this.detection.isRegisteredChild(ctx)) {
      publishPermissionsService(this.service);
      publishPermissionConfigService(this.configService);
    }
    emitReadyEvent(this.events);
  }

  teardown(): void {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    unpublishPermissionsService(this.service);
    unpublishPermissionConfigService(this.configService);
  }
}
