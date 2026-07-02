/**
 * Assistant chat history — the AUTH BOUNDARY for the gateway's persisted conversations.
 *
 * The llm-gateway stores every conversation session as a chat (its /chats API) but has no user
 * sessions of its own, so it cannot verify WHO is asking. The hub can (login bearer tokens). These
 * routes are that bridge: `requireAuth` resolves the member, and the proxy injects
 * `owner = req.user.id` — the caller never chooses whose chats to read. The gateway side requires
 * the shared service token, so the dashboard cannot bypass this boundary by calling it directly.
 */
import { Express } from 'express';
import axios from 'axios';
import { requireAuth } from '../auth/middleware';

const GATEWAY_URL = process.env.LLM_GATEWAY_URL || 'http://127.0.0.1:8090';
const SERVICE_TOKEN = process.env.HUB_SERVICE_TOKEN || '';

const gatewayHeaders = () => (SERVICE_TOKEN ? { 'X-Hub-Service-Token': SERVICE_TOKEN } : {});

/** These routes are HUMAN-only: requireAuth also admits service-token callers (no req.user attached),
 *  but a chat list without a member to scope to must be refused, not crash into an unscoped read. */
function memberId(request: any): string | null {
  return request.user?.id ?? null;
}

export function initAssistantChatRoutes(app: Express) {
  app.get('/assistant/chats', requireAuth, async (request, response) => {
    try {
      const owner = memberId(request);
      if (!owner) return response.status(401).send({ error: 'member session required' });
      const r = await axios.get(`${GATEWAY_URL}/chats`, { params: { owner }, headers: gatewayHeaders(), timeout: 5000 });
      response.send(r.data);
    } catch {
      response.status(502).send({ error: 'chat store unreachable' });
    }
  });

  app.get('/assistant/chats/:id', requireAuth, async (request, response) => {
    try {
      const owner = memberId(request);
      if (!owner) return response.status(401).send({ error: 'member session required' });
      const r = await axios.get(`${GATEWAY_URL}/chats/${encodeURIComponent(request.params.id)}`, {
        params: { owner },
        headers: gatewayHeaders(),
        timeout: 5000,
        validateStatus: (s) => s === 200 || s === 404,
      });
      response.status(r.status).send(r.data);
    } catch {
      response.status(502).send({ error: 'chat store unreachable' });
    }
  });

  app.post('/assistant/chats/close', requireAuth, async (request, response) => {
    try {
      const owner = memberId(request);
      if (!owner) return response.status(401).send({ error: 'member session required' });
      const r = await axios.post(`${GATEWAY_URL}/chats/close`, { owner }, { headers: gatewayHeaders(), timeout: 5000 });
      response.send(r.data);
    } catch {
      response.status(502).send({ error: 'chat store unreachable' });
    }
  });

  app.delete('/assistant/chats/:id', requireAuth, async (request, response) => {
    try {
      const owner = memberId(request);
      if (!owner) return response.status(401).send({ error: 'member session required' });
      const r = await axios.delete(`${GATEWAY_URL}/chats/${encodeURIComponent(request.params.id)}`, {
        params: { owner },
        headers: gatewayHeaders(),
        timeout: 5000,
      });
      response.send(r.data);
    } catch {
      response.status(502).send({ error: 'chat store unreachable' });
    }
  });
}
