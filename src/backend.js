import { BridgeError, decode, completion } from './protocol.js';
import { Conversations } from './conversations.js';
import { buildHandoff, handoffInput, rejectFeedback, validateAction } from './handoff.js';
import { rawMaterial, repair, resendPrompt } from './repair.js';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Keep official approval gates active. No native operation is ever approved.
export const nativePermissions = { '*': 'ask', question: 'deny', websearch: 'deny', codesearch: 'deny', webfetch: 'deny', task: 'deny', plan_enter: 'deny', plan_exit: 'deny', todowrite: 'deny' };

export function freeModels(providers) {
  const provider = providers.all?.find(p => p.id === 'opencode');
  if (!provider) throw new Error('OpenCode provider missing');
  return Object.entries(provider.models).filter(([, m]) => {
    const c = m.cost;
    return c && c.input === 0 && c.output === 0 && (c.cache?.read ?? 0) === 0 && (c.cache?.write ?? 0) === 0
      && m.capabilities?.output?.text !== false && m.status !== 'deprecated';
  }).map(([id, m]) => ({ id: `opencode/${id}`, name: m.name || id, context: m.limit?.context, input: m.limit?.input, images: m.capabilities?.input?.image === true, output: m.limit?.output, toolcall: m.capabilities?.toolcall === true, reasoning: m.capabilities?.reasoning === true, variants: m.variants ?? {} }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Approval payloads can carry file content; keep the shape but bound long strings.
export function shrinkPermission(value, limit = 400) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…[${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(item => shrinkPermission(item, limit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkPermission(item, limit)]));
  return value;
}

function allowedTools(request) {
  return request.choice === 'none' ? [] : request.tools.filter(t => !request.forced || t.function.name === request.forced);
}

export class Backend {
  constructor(base, password, timeout, log = () => {}) {
    Object.assign(this, { base, password, timeout, log, active: new Map(), events: null, toolParts: new Map(), pendingApprovals: new Map(), usageBySession: new Map(), translator: null });
  }
  closeSessions() { return this.conversations?.close(); }
  headers() {
    return { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}` };
  }
  async request(route, method = 'GET', body, signal, timeout = this.timeout) {
    const requestSignal = timeout == null ? signal : AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    return new Promise((resolve, reject) => {
      // Local inference has no proxy-owned deadline or HTTP client's implicit response timeout.
      const req = httpRequest(this.base + route, {
        method, signal: requestSignal, headers: this.headers(),
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (response.statusCode < 200 || response.statusCode >= 300)
            return reject(new BridgeError(`OpenCode HTTP ${response.statusCode}: ${text.slice(0, 600)}`, response.statusCode >= 500 ? 502 : response.statusCode, 'upstream_error'));
          try { resolve(response.statusCode === 204 ? null : JSON.parse(text)); }
          catch { reject(new BridgeError('OpenCode returned non-JSON response', 502, 'upstream_error')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(0);
      req.end(body !== undefined ? JSON.stringify(body) : undefined);
    });
  }

  // One event-stream connection serves every in-flight request: OpenCode reports its own
  // upstream retries there, which the request/response path never exposes.
  watchEvents() {
    if (this.events) return;
    const controller = new AbortController();
    this.events = controller;
    (async () => {
      while (!controller.signal.aborted) {
        try { await this.streamEvents(controller.signal); }
        catch (e) { if (controller.signal.aborted) return; this.log(`Event stream error: ${e.message}`); }
        await delay(1000, undefined, { signal: controller.signal, ref: false }).catch(() => {});
      }
    })().catch(() => {});
  }
  stopEvents() {
    this.events?.abort();
    this.events = null;
  }
  streamEvents(signal) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(this.base + '/event', { method: 'GET', signal, headers: { ...this.headers(), Accept: 'text/event-stream' } }, response => {
        if (response.statusCode !== 200) { response.resume(); return reject(new BridgeError(`Event stream HTTP ${response.statusCode}`, 502, 'event_stream_error')); }
        let buffer = '';
        response.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try { this.handleEvent(JSON.parse(line.slice(5).trim())); } catch {}
          }
        });
        response.on('error', reject);
        response.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
  }
  handleEvent(wrapper) {
    const event = wrapper?.payload ?? wrapper;
    if (['permission.asked', 'permission.updated'].includes(event?.type) && event.properties?.id)
      this.pendingApprovals.set(event.properties.id, event.properties);
    if (event?.type === 'permission.replied') this.pendingApprovals.delete(event.properties?.requestID);
    // The tool part carries the name and arguments of a call that an approval gate blocked.
    // It arrives here before the approval does, and the HTTP listing of messages does not.
    const part = event?.type === 'message.part.updated' ? event.properties?.part : undefined;
    if (part?.type === 'tool' && part.callID) {
      this.toolParts.set(part.callID, { tool: part.tool, input: part.state?.input ?? {} });
      if (this.toolParts.size > 50) this.toolParts.delete(this.toolParts.keys().next().value);
    }
    const info = event?.type === 'message.updated' ? event.properties?.info : undefined;
    if (info?.role === 'assistant' && info.tokens && this.usageBySession.has(info.sessionID)) this.usageBySession.set(info.sessionID, info.tokens);
    const sessionID = event?.properties?.sessionID ?? part?.sessionID ?? info?.sessionID;
    const meta = sessionID ? this.active.get(sessionID) : undefined;
    if (!meta || typeof meta.activity !== 'function') return;
    const status = event.properties?.status;
    const progress = { sessionID, model: meta.model, type: event.type, at: Date.now() };
    if (event.type === 'session.status' && status) {
      if (status.type === 'retry' || (status.type === 'busy' && (!meta.stage || meta.stage === 'retry'))) progress.status = status.type === 'busy' ? 'waiting' : 'retry';
      if (status.type === 'retry') Object.assign(progress, { attempt: status.attempt, message: status.message, next: status.next });
    }
    if (event.type === 'session.error') progress.error = event.properties?.error?.data?.message || event.properties?.error?.name || '上游错误';
    if (part && ['text', 'reasoning'].includes(part.type) && part.text) {
      progress.content = true; progress.status = part.type === 'reasoning' ? 'reasoning' : 'receiving';
    }
    if (event.type === 'message.part.delta' && event.properties?.delta) {
      progress.content = true; progress.status = 'receiving';
    }
    if (['permission.asked', 'permission.updated'].includes(event.type)) progress.status = 'permission';
    if (progress.status) meta.stage = progress.status;
    meta.activity(progress);
  }

  progress(meta, status, extra = {}) {
    meta.stage = status;
    meta.activity?.({ sessionID: meta.sessionID, model: meta.model, type: 'bridge.phase', status, ...extra });
  }

  async reject(permission, message, signal) {
    const result = await this.request(`/permission/${encodeURIComponent(permission.id)}/reply`, 'POST', { reply: 'reject', message }, signal, 5000);
    this.pendingApprovals.delete(permission.id);
    return result;
  }
  // The name of the blocked call comes from the event stream; the arguments may still be
  // empty while the part is pending, and handoffInput() then fills them from the approval.
  async blockedAction(callID, signal) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const part = this.toolParts.get(callID);
      if (part?.tool) return part;
      await delay(120, undefined, { signal, ref: false }).catch(() => {});
    }
    return { failure: 'no event carried this call ID' };
  }
  async pendingPermissions(sessionID, signal) {
    const cached = () => [...this.pendingApprovals.values()].filter(p => p.sessionID === sessionID);
    let pending;
    try { pending = await this.request('/permission', 'GET', undefined, signal, 5000); }
    catch (error) {
      if (!signal?.aborted) this.log(`Permission monitor query failed: ${error.code || error.name}${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}`);
      return cached();
    }
    if (!Array.isArray(pending)) { this.log('Permission monitor query failed: non-array response'); return cached(); }
    return pending.filter(p => p.sessionID === sessionID);
  }
  async handoffUsage(sessionID, signal) {
    // Abort finishes the interrupted assistant message before session cleanup removes it.
    try {
      const messages = await this.request(`/session/${encodeURIComponent(sessionID)}/message?limit=1`, 'GET', undefined, signal, 5000);
      const info = Array.isArray(messages) ? messages.findLast(m => m.info?.role === 'assistant')?.info : undefined;
      if (info?.tokens) return info.tokens;
    } catch (error) {
      if (!signal?.aborted) this.log(`Usage lookup failed: ${error.code || error.name}`);
    }
    return this.usageBySession.get(sessionID);
  }
  // Refuse one native approval, or hand it to the external client. Returns { handoff } when
  // the action was handed over, so the caller can stop this generation and answer with it.
  async handlePermission(p, request, signal, rejected, meta) {
    const callID = p.tool?.callID;
    if (callID && rejected.has(callID)) return null;
    if (callID) rejected.add(callID);
    meta.nativeAttempts += 1;
    // Keep the approval request verbatim: OpenCode's field names differ from the SDK
    // types, so cherry-picking fields silently loses the useful ones.
    if (meta.permissions.length < 5) meta.permissions.push(shrinkPermission(p));
    const action = callID ? await this.blockedAction(callID, signal) : null;
    const native = action?.tool ?? (p.metadata?.command ? 'bash' : null);
    const handoff = native ? buildHandoff({ native, input: handoffInput(action, p), tools: allowedTools(request) }) : null;
    if (!handoff) {
      meta.handoffCheck = { native: native ?? null, offeredTools: request.tools.length, detail: action?.failure ?? 'arguments incomplete for the external schema' };
      // The action exists and only its expression is missing: keep it for the translator.
      if (native) meta.handoffMiss = { native, input: handoffInput(action, p), offeredTools: request.tools.length };
    }
    if (handoff) {
      this.progress(meta, 'handoff');
      await this.reject(p, 'This native action is executed by the external client instead.', signal).catch(() => {});
      return { handoff };
    }
    const reason = !callID ? 'the approval request carries no call ID, so it cannot be matched to the external tool list'
      : action ? 'its arguments cannot be mapped onto an external tool schema supplied in this request'
        : 'the call could not be read back from the session';
    // Without the tool part, name what can be known instead of blaming the permission kind.
    const label = native || (p.metadata?.filepath ? `a file operation on ${p.metadata.filepath}` : p.permission || 'native tool');
    // A permission may already be gone (session aborted, duplicate reply): never let that
    // failing reply take the whole request down with it.
    await this.reject(p, rejectFeedback(label, reason), signal).catch(() => {});
    return null;
  }

  async models() {
    const result = freeModels(await this.request('/provider'));
    if (!result.length) throw new Error('No free text models found; existing list preserved');
    return result;
  }
  // One bounded job for a second model: turn the material into the shape the receiver expects.
  // The result is validated by the receiver's own rules, so a translation can never widen what is
  // allowed; anything else falls back to the original error.
  translate(request, shape, material, meta, blocked, signal) {
    const deadline = AbortSignal.timeout(20000);
    // What the client would run is still decided by the client's own rules: a name it did not offer,
    // or arguments that break its schema, are refused no matter how the translation was reached.
    return repair({
      complete: inner => this.complete(inner, signal ? AbortSignal.any([deadline, signal]) : deadline, {
        model: inner.model.id,
        ...(meta.activity ? { activity: progress => {
          if (progress.type !== 'request.done') meta.activity({ sessionID: meta.sessionID, model: meta.model,
            type: 'bridge.repair', status: 'repair', repairModel: inner.model.id, ...(progress.content ? { content: true } : {}) });
        } } : {}),
      }),
      translator: (...args) => {
        const model = this.translator?.(...args);
        this.progress(meta, 'repair', { repairModel: model || null });
        return model;
      }, request: { ...request, tools: allowedTools(request) }, shape, material, blocked, meta, log: this.log,
      validate: shape === 'action'
        ? candidate => {
          const action = validateAction(candidate, allowedTools(request));
          decode(JSON.stringify({ content: '', calls: [action] }), request);
          return action;
        }
        : candidate => decode(JSON.stringify(candidate), request),
    });
  }

  async complete(request, signal, meta = {}) {
    if (request.conversationKey && !meta.probe) {
      this.conversations ||= new Conversations(id => this.request(`/session/${encodeURIComponent(id)}`, 'DELETE', undefined, undefined, 5000).catch(e => this.log(`Session cleanup failed: ${e.code || e.name}`)));
      return this.conversations.run(request, signal, lease => this.completeSession(request, signal, meta, lease));
    }
    return this.completeSession(request, signal, meta);
  }
  async completeSession(request, signal, meta, lease) {
    meta.steps = 0; meta.nativeAttempts = 0; meta.permissions = [];
    // Native tools require approval; the bridge aborts any attempted native action.
    const session = lease?.session || await this.request('/session', 'POST', { title: 'OW Bridge', permission: Object.entries(nativePermissions).map(([permission, action]) => ({ permission, pattern: '*', action })) }, signal);
    if (lease) lease.session = session;
    const route = `/session/${encodeURIComponent(session.id)}`;
    meta.sessionID = session.id;
    this.usageBySession.set(session.id, undefined);
    if (typeof meta.activity === 'function') this.active.set(session.id, meta);
    this.watchEvents();
    this.progress(meta, 'waiting');
    const guard = new AbortController();
    const rejected = new Set();
    const guardSignal = AbortSignal.any([guard.signal, ...(signal ? [signal] : [])]);
    const watch = (async () => {
      while (!guardSignal.aborted) {
        const pending = await this.pendingPermissions(session.id, guardSignal);
        // A failed poll does not grant approval: native actions remain waiting.
        // Keep polling while inference runs; cancellation and inference errors still propagate.
        for (const p of pending ?? []) {
          if (request.chatOnly) throw new BridgeError('Chat-only model attempted native tool use; execution blocked', 502, 'native_tool_activity');
          const result = await this.handlePermission(p, request, guardSignal, rejected, meta);
          if (result?.handoff) return result;
        }
        await delay(250, undefined, { signal: guardSignal });
      }
    })();
    let successful = false;
    try {
      const tools = allowedTools(request);
      const callsSchema = { type: 'array', ...(request.parallel ? {} : { maxItems: 1 }),
        ...(request.choice === 'required' || request.forced ? { minItems: 1 } : {}),
        ...(tools.length ? { items: { anyOf: tools.map(({ function: tool }) => ({
          type: 'object', properties: { name: { type: 'string', const: tool.name }, arguments: tool.parameters || { type: 'object' } },
          required: ['name', 'arguments'], additionalProperties: false,
        })) } } : { maxItems: 0, items: { type: 'object' } }),
      };
      const payload = {
        model: { providerID: 'opencode', modelID: request.model.id.slice('opencode/'.length) },
        ...(request.variant ? { variant: request.variant } : {}),
        agent: request.chatOnly ? 'buddy-chat' : 'buddy-bridge', system: request.chatOnly ? request.system : request.system + '\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.',
        ...(request.chatOnly ? {} : { format: { type: 'json_schema', retryCount: 0, schema: {
          type: 'object', properties: { content: { type: 'string' }, calls: callsSchema },
          required: ['content', 'calls'], additionalProperties: false,
        } } }),
        parts: [...(lease?.toolCalls?.length ? [{ type: 'text', text: `The previous response was assigned these external tool call IDs, in the same order as its calls. Match the new tool results to them: ${JSON.stringify(lease.toolCalls.map(call => ({ id: call.id, name: call.function.name })))}` }] : []), { type: 'text', text: lease?.text ?? request.text }, ...(lease?.images ?? request.images ?? [])],
      };
      let actionRetried = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        meta.steps += 1;
        this.progress(meta, attempt ? 'correcting' : 'waiting');
        this.usageBySession.set(session.id, undefined);
        const response = await Promise.race([watch, this.request(`${route}/message`, 'POST', payload, signal, null)]);
        this.progress(meta, 'checking');
        let handoff = response?.handoff ?? null;
        if (!handoff) {
          // Close the race: an approval raised just before the response landed must still be
          // refused or handed over, otherwise its tool part looks like unexpected activity.
          const late = await this.pendingPermissions(session.id, guardSignal);
          for (const p of late ?? []) {
            if (request.chatOnly && p.tool) throw new BridgeError('Chat-only model attempted native tool use; execution blocked', 502, 'native_tool_activity');
            const result = await this.handlePermission(p, request, guardSignal, rejected, meta);
            if (result?.handoff) { handoff = result.handoff; break; }
          }
        }
        // A handed-over action becomes the model's answer; no second upstream turn is spent.
        if (handoff) {
          await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
          meta.calls = 1;
          meta.handoff = handoff.name;
          successful = true;
          return completion(request.model.id, { role: 'assistant', content: null,
            tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
              function: { name: handoff.name, arguments: JSON.stringify(handoff.arguments) } }] }, await this.handoffUsage(session.id, signal));
        }
        if (response.info?.error && (request.chatOnly || response.info.error.name !== 'StructuredOutputError')) {
          const error = response.info.error;
          throw new BridgeError(error.data?.message || error.message || error.name || 'Model request failed', error.data?.statusCode || 502, 'model_error');
        }
        // 'invalid' is how OpenCode marks a call whose arguments failed to parse: nothing executed,
        // so it belongs to the format path (correction, then translation), not to native activity.
        if (response.parts?.some(p => p.type === 'tool' && (request.chatOnly || !['StructuredOutput', 'invalid'].includes(p.tool)) && !(rejected.has(p.callID) && p.state?.status === 'error'))) throw new BridgeError('Unexpected native tool activity; response rejected', 502, 'native_tool_activity');
        // The envelope arrives one of three ways: OpenCode's structured field, the completed
        // StructuredOutput call this adapter asks for, or plain text. Reading only the first
        // and the last rejected a correct answer once, so all three are accepted.
        const structuredPart = (response.parts || []).find(p => p.type === 'tool' && p.tool === 'StructuredOutput' && p.state?.status === 'completed' && p.state?.input);
        const envelope = response.info?.structured ?? structuredPart?.state?.input;
        const text = envelope !== undefined ? JSON.stringify(envelope) : (response.parts || []).filter(p => p.type === 'text').map(p => p.text).join('');
        let message;
        try {
          // A reply cut off by the output limit is a failure the model can fix once it is told.
          if (response.info?.finish === 'length') throw new BridgeError('Model output was truncated', 502, 'output_truncated');
          if (!text.trim()) {
            // Name the real cause, and take the same path as any other unreadable reply: an empty
            // envelope deserves the one correction and the translator just like a malformed one.
            const unparsed = (response.parts || []).find(p => p.type === 'tool' && p.tool === 'invalid');
            if (request.chatOnly) throw new BridgeError('Model returned no text', 502, 'empty_response');
            throw new BridgeError(unparsed
              ? `模型交的调用参数不是合法 JSON：${unparsed.state?.input?.error ?? 'no detail from the runtime'}`
              : '模型没有返回信封：structured、已完成的 StructuredOutput 调用、文本 part 三者都为空', 502, 'invalid_model_output');
          }
          message = request.chatOnly ? { role: 'assistant', content: text } : decode(text, request);
        }
        catch (error) {
          // One correction, one translation, one explicit retry: bounded, and only ever on a path
          // that has already failed. A malformed envelope and a reply cut off by the output limit
          // both land here; unexpected native activity still never does.
          if (request.chatOnly || signal?.aborted || !['invalid_model_output', 'invalid_tool_call', 'output_truncated'].includes(error.code)) throw error;
          const cut = error.code === 'output_truncated';
          if (!attempt) {
            payload.parts = [{ type: 'text', text: cut
              ? 'Your previous response was cut off by the output limit before the envelope was complete. Send it again in a much more compact form: content holds the conclusion, calls hold only the essential arguments, and keep reasoning to a minimum.'
              : 'Your previous response failed the adapter JSON format check. No external tool has been executed from that response. Return the intended answer or external tool proposal using StructuredOutput with exactly {"content":"a string, empty if only calling tools","calls":[{"name":"an allowed external tool name","arguments":{}}]}. Both fields are required; use [] when no tools are needed. Do not invoke native tools, repeat external searches, or claim actions have completed. Preserve the external conversation and its existing tool results.' }];
            continue;
          }
          if (attempt === 1) {
            // Still unreadable: hand the material to the translator. Detection never translates, so a
            // probe keeps measuring the model rather than the translator's help.
            if (!meta.probe) {
              const translated = await this.translate(request, 'envelope', rawMaterial(response, request, error), meta, null, signal);
              if (translated) { meta.calls = translated.tool_calls?.length ?? 0; successful = true; return completion(request.model.id, translated, response.info?.tokens); }
              // Nothing was inferable, so the model gets one more round with the failure spelled out
              // instead of the turn simply dying here.
              payload.parts = [{ type: 'text', text: resendPrompt({ error, repair: meta.repaired?.envelope }) }];
              continue;
            }
          }
          throw error;
        }
        // The model tried to act natively, the table could not express it, and it then answered
        // with text. Translate the blocked action and return it, exactly as a handoff would.
        if (!message.tool_calls?.length && meta.handoffMiss && !meta.probe && !actionRetried) {
          const rescued = await this.translate(request, 'action', rawMaterial(response, request), meta, meta.handoffMiss, signal);
          if (rescued) {
            await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
            meta.calls = 1;
            meta.handoff = rescued.name;
            successful = true;
            return completion(request.model.id, { role: 'assistant', content: null,
              tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
                function: { name: rescued.name, arguments: JSON.stringify(rescued.arguments) } }] }, response.info?.tokens ?? await this.handoffUsage(session.id, signal));
          }
          if (attempt < 2 && !signal?.aborted) {
            actionRetried = true;
            payload.parts = [{ type: 'text', text: resendPrompt({ repair: meta.repaired?.action, blocked: meta.handoffMiss }) }];
            continue;
          }
        }
        meta.calls = message.tool_calls?.length ?? 0;
        successful = true;
        if (lease) lease.reusable = true;
        return completion(request.model.id, message, response.info?.tokens);
      }
    } finally {
      guard.abort();
      await watch.catch(() => {});
      this.usageBySession.delete(session.id);
      if (!this.usageBySession.size) this.stopEvents();
      for (const [id, permission] of this.pendingApprovals)
        if (permission.sessionID === session.id) this.pendingApprovals.delete(id);
      if (typeof meta.activity === 'function') {
        meta.activity({ sessionID: session.id, model: meta.model, type: 'request.done' });
        this.active.delete(session.id);
      }
      // Cancellation must stop backend work, not merely disconnect the HTTP request.
      if (!successful) await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
      if (!lease?.reusable) await this.request(route, 'DELETE', undefined, undefined, 5000).catch(e => console.error('Session cleanup failed:', e.code || e.name));
    }
  }
}
