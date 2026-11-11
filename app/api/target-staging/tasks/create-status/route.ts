/** R3-BE-4c.2: exact-command create recovery, default-off. */
import {postPrivateTaskCreateStatus} from "../../../../../lib/target-private-task-create-http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const POST=postPrivateTaskCreateStatus;
