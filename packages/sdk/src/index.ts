// The protocol types and schemas are part of the SDK's public surface:
// users get Sandbox, AcquireResponse, lifecycle constants etc. from here
// without installing @dormice/shared themselves.
export * from '@dormice/shared';
export { Dormice, DormiceApiError, type DormiceOptions } from './client';
