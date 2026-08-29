/**
 * Test setup.
 *
 * The tests drive a stubbed global `fetch`, so the transport is pinned to the
 * fetch sender. The Node sender has its own tests, against a real local server.
 */
import { fetchSender, useSender } from '../client/transport';

useSender(fetchSender);
