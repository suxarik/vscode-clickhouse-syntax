/**
 * The seam between the grid and its host.
 *
 * A webview panel and a notebook output renderer deliver messages differently.
 * The grid only knows this interface, so the same bundle serves both.
 */
import { HostMessage, ViewMessage } from '../protocol';

export interface Transport {
    post(message: ViewMessage): void;
    onMessage(handler: (message: HostMessage) => void): void;
}
