/**
 * BunSocketWrapper class declaration for type exports
 * @public
 */
export class BunSocketWrapper {
    ws;
    remoteAddress;
    send;
    ping;
    close;
    terminate;
    _handleMessage;
    _handleClose;
}
