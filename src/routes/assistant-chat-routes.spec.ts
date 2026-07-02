/**
 * /assistant/chats proxy — the auth boundary contract:
 *   1. owner is ALWAYS req.user.id (the verified member) — never anything the caller sent;
 *   2. a service-token caller (requireAuth passes, no req.user) is refused, not unscoped;
 *   3. gateway calls carry the shared service token.
 * The hub test suite is pure-function style (no HTTP harness), so we capture the handlers off a fake
 * app and drive them with fake req/res; axios is mocked.
 */
import axios from 'axios';

jest.mock('axios');
jest.mock('../auth/middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

import { initAssistantChatRoutes } from './assistant-chat-routes';

const mockedAxios = axios as jest.Mocked<typeof axios>;

type Handler = (req: any, res: any) => Promise<void>;
const handlers: Record<string, Handler> = {};
const fakeApp: any = {
  get: (path: string, _auth: any, h: Handler) => (handlers[`GET ${path}`] = h),
  post: (path: string, _auth: any, h: Handler) => (handlers[`POST ${path}`] = h),
  delete: (path: string, _auth: any, h: Handler) => (handlers[`DELETE ${path}`] = h),
};
initAssistantChatRoutes(fakeApp);

function fakeRes() {
  const res: any = { statusCode: 200 };
  res.status = (s: number) => ((res.statusCode = s), res);
  res.send = (b: any) => ((res.body = b), res);
  return res;
}

describe('/assistant/chats proxy', () => {
  beforeEach(() => jest.clearAllMocks());

  it('injects owner = req.user.id — a caller-supplied owner param is ignored', async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { ok: true, chats: [] } });
    const res = fakeRes();
    await handlers['GET /assistant/chats'](
      { user: { id: 'u_david' }, query: { owner: 'u_victim' }, params: {} },
      res,
    );
    const [url, cfg] = mockedAxios.get.mock.calls[0];
    expect(url).toMatch(/\/chats$/);
    expect(cfg!.params).toEqual({ owner: 'u_david' }); // NOT u_victim
    expect(res.body.ok).toBe(true);
  });

  it('refuses a session-less caller (service token passes requireAuth but attaches no user)', async () => {
    const res = fakeRes();
    await handlers['GET /assistant/chats']({ query: {}, params: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('forwards the service token to the gateway and relays a 404 verbatim', async () => {
    process.env.HUB_SERVICE_TOKEN = 'tkn'; // note: module read the env at import; header presence
    mockedAxios.get.mockResolvedValueOnce({ status: 404, data: { error: 'not found' } });
    const res = fakeRes();
    await handlers['GET /assistant/chats/:id']({ user: { id: 'u_david' }, query: {}, params: { id: 'c1' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('close posts the member as owner', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { ok: true } });
    const res = fakeRes();
    await handlers['POST /assistant/chats/close']({ user: { id: 'u_ana' }, query: {}, params: {} }, res);
    const [, body] = mockedAxios.post.mock.calls[0];
    expect(body).toEqual({ owner: 'u_ana' });
  });

  it('maps a gateway outage to 502, not a crash', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = fakeRes();
    await handlers['GET /assistant/chats']({ user: { id: 'u_david' }, query: {}, params: {} }, res);
    expect(res.statusCode).toBe(502);
  });
});
