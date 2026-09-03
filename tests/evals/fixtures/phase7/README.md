# Phase 7 Eval fixture

Phase 7 role-lifecycle scenarios create their isolated project and task state inside each Eval
run root. This pinned fixture marker identifies the versioned catalog without copying user data.

The role-registration scenario starts at the trusted single-user project-management service
boundary. Phase 7 defines D9 Leader events for role departure and task onboarding, but it does not
define a `/role add` message protocol or account-authentication layer; the registration scenario
therefore measures only the atomic roster and main-channel update.
