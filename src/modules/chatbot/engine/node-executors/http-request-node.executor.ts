import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig, Method } from 'axios';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executor.interface';

interface HttpAuth {
  type?: 'none' | 'bearer' | 'basic' | 'apiKey';
  token?: string;
  username?: string;
  password?: string;
  headerName?: string;
  headerValue?: string;
}

/**
 * Nó de REQUISIÇÃO HTTP: chama uma API externa (com autenticação), salva a
 * resposta em variáveis e ramifica por sucesso/erro. Suporta interpolação
 * {{var}} em URL, headers e body.
 *
 * nodeData: {
 *   method, url, headers?, body?, auth?,
 *   saveAs?          -> nome da variável com a resposta (default apiResponse)
 *   responsePath?    -> caminho pra extrair (ex.: "data.items.0.id")
 * }
 * Edges: condition 'success' | 'error' (senão usa a 1ª/2ª aresta).
 */
@Injectable()
export class HttpRequestNodeExecutor implements NodeExecutor {
  readonly nodeType = 'HTTP_REQUEST';
  private readonly logger = new Logger(HttpRequestNodeExecutor.name);

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const vars = ctx.session.variables;
    const d = ctx.nodeData as Record<string, any>;
    const saveAs = (d.saveAs as string) || 'apiResponse';

    const method = ((d.method as string) || 'GET').toUpperCase() as Method;
    const url = this.interp(d.url || '', vars);
    const headers = this.interpObj(d.headers || {}, vars);
    const auth = (d.auth || {}) as HttpAuth;

    const config: AxiosRequestConfig = { method, url, headers, timeout: 20000 };

    switch (auth.type) {
      case 'bearer':
        config.headers = { ...headers, Authorization: `Bearer ${this.interp(auth.token || '', vars)}` };
        break;
      case 'basic':
        config.auth = {
          username: this.interp(auth.username || '', vars),
          password: this.interp(auth.password || '', vars),
        };
        break;
      case 'apiKey':
        if (auth.headerName)
          config.headers = { ...headers, [auth.headerName]: this.interp(auth.headerValue || '', vars) };
        break;
    }

    if (d.body && method !== 'GET') {
      const raw = this.interp(typeof d.body === 'string' ? d.body : JSON.stringify(d.body), vars);
      try {
        config.data = JSON.parse(raw);
      } catch {
        config.data = raw;
      }
    }

    let status = 0;
    let payload: any = null;
    let ok = false;
    try {
      const res = await axios(config);
      status = res.status;
      payload = res.data;
      ok = status >= 200 && status < 300;
    } catch (err: any) {
      status = err?.response?.status || 0;
      payload = err?.response?.data ?? { error: err?.message };
      ok = false;
      this.logger.warn(`HTTP node falhou (${status}): ${err?.message}`);
    }

    const extracted = d.responsePath ? this.drill(payload, d.responsePath) : payload;
    const updatedVariables: Record<string, any> = {
      [saveAs]: extracted,
      [`${saveAs}_status`]: status,
    };

    const successEdge = ctx.nodeEdges.find((e) => e.condition === 'success');
    const errorEdge = ctx.nodeEdges.find((e) => e.condition === 'error');
    const nextNodeId = ok
      ? successEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null
      : errorEdge?.targetNodeId || ctx.nodeEdges[1]?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null;

    return { nextNodeId, sendMessages: [], waitForInput: false, updatedVariables };
  }

  private interp(t: string, vars: Record<string, any>): string {
    return String(t).replace(/\{\{(\w+)\}\}/g, (_, k) =>
      vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`,
    );
  }
  private interpObj(obj: Record<string, any>, vars: Record<string, any>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = this.interp(String(v), vars);
    return out;
  }
  private drill(obj: any, path: string): any {
    return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
  }
}
