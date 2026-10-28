/**
 * Live MCP connections for a session. Enabled servers start in the
 * background when the session opens; their tools appear to the model as
 * mcp__<server>__<tool>. Four management tools let the agent inspect and
 * call servers whose tools are not individually exposed.
 */
import { connectMcp, mcpResultContent } from './client.mjs';
import { loadMcpServers } from './config.mjs';

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

export class McpManager {
  constructor({ cwd, readConfigFrom, log = () => {} }) {
    this.cwd = cwd;
    this.log = log;
    this.servers = loadMcpServers({ cwd, readConfigFrom });
    this.state = new Map(); // name -> { status, client?, error?, promise? }
  }

  enabledNames() { return Object.entries(this.servers).filter(([, s]) => !s.disabled).map(([n]) => n); }

  start() {
    for (const name of this.enabledNames()) this.connect(name).catch(() => {});
  }

  connect(name) {
    const cur = this.state.get(name);
    if (cur?.promise) return cur.promise;
    const cfg = this.servers[name];
    if (!cfg) return Promise.reject(new Error(`No MCP server named '${name}'`));
    const promise = connectMcp(name, cfg, { cwd: this.cwd }).then((client) => {
      this.state.set(name, { status: 'connected', client, promise });
      this.log(`MCP ${name}: connected, ${client.tools.length} tools`);
      return client;
    }, (e) => {
      this.state.set(name, { status: 'failed', error: e.message, promise });
      this.log(`MCP ${name}: ${e.message}`);
      throw e;
    });
    this.state.set(name, { status: 'connecting', promise });
    return promise;
  }

  /** Wait (bounded) for servers still starting, so the first turn sees their tools. */
  async settle(ms = 8000) {
    const pending = [...this.state.values()].filter((s) => s.status === 'connecting').map((s) => s.promise.catch(() => {}));
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, ms))]);
  }

  /** Tool definitions for every connected server. */
  tools() {
    const out = [];
    for (const [name, st] of this.state) {
      if (st.status !== 'connected') continue;
      const hidden = new Set(this.servers[name]?.disabledTools || []);
      for (const t of st.client.tools) {
        if (hidden.has(t.name)) continue;
        out.push(this.toolDef(name, t));
      }
    }
    return out;
  }

  toolDef(server, t) {
    const mgr = this;
    return {
      name: `mcp__${sanitize(server)}__${sanitize(t.name)}`.slice(0, 64),
      kind: 'mcp',
      readOnly: !!t.annotations?.readOnlyHint,
      description: `[MCP ${server}] ${t.description || t.name}`.slice(0, 1024),
      input_schema: t.inputSchema && typeof t.inputSchema === 'object' ? { type: 'object', ...t.inputSchema } : { type: 'object', properties: {} },
      target: () => null,
      async run(input) {
        const client = await mgr.connect(server);
        return mcpResultContent(await client.call(t.name, input));
      },
    };
  }

  status() {
    return Object.entries(this.servers).map(([name, s]) => {
      const st = this.state.get(name);
      return { name, source: s.source, provider: s.provider, disabled: !!s.disabled, status: s.disabled ? 'disabled' : st?.status || 'not started', error: st?.error, tools: st?.client?.tools?.length ?? null };
    });
  }

  managementTools() {
    const mgr = this;
    return [
      {
        name: 'mcp_list_servers', kind: 'meta',
        description: 'List configured MCP servers and their connection status.',
        input_schema: { type: 'object', properties: {} },
        target: () => null,
        async run() { return { content: JSON.stringify(mgr.status(), null, 2) }; },
      },
      {
        name: 'mcp_list_tools', kind: 'meta',
        description: 'List the tools (with input schemas) one MCP server offers.',
        input_schema: { type: 'object', properties: { server: { type: 'string' } }, required: ['server'] },
        target: () => null,
        async run({ server }) {
          const c = await mgr.connect(server);
          return { content: JSON.stringify(c.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })), null, 2) };
        },
      },
      {
        name: 'mcp_call_tool', kind: 'mcp',
        description: 'Call a tool on an MCP server by name.',
        input_schema: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['server', 'tool'] },
        target: () => null,
        async run({ server, tool, arguments: args }) {
          if ((mgr.servers[server]?.disabledTools || []).includes(tool)) return { isError: true, content: `${tool} is disabled for ${server}.` };
          const c = await mgr.connect(server);
          return mcpResultContent(await c.call(tool, args || {}));
        },
      },
      {
        name: 'mcp_read_resource', kind: 'meta',
        description: 'Read a resource (by URI) from an MCP server.',
        input_schema: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } }, required: ['server', 'uri'] },
        target: () => null,
        async run({ server, uri }) {
          const c = await mgr.connect(server);
          const r = await c.request?.('resources/read', { uri });
          if (!r) return { isError: true, content: 'This server does not support resources.' };
          return { content: (r.contents || []).map((x) => x.text ?? `[${x.mimeType || 'binary'} ${x.uri}]`).join('\n') };
        },
      },
    ];
  }

  close() { for (const st of this.state.values()) st.client?.close(); }
}
