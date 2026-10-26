import type { IpcApi } from '../shared/types';

declare global {
  interface Window {
    mdm: IpcApi;
  }
}

export {};
