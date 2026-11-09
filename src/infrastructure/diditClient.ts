import type { DiditClient } from "../domain/kyc";

interface DiditSessionResponse {
  session_id: string;
  url: string;
}

export class DiditHTTPClient implements DiditClient {
  constructor(
    private baseURL: string,
    private apiKey: string,
    private fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async crearSesion(
    workflowId: string,
    vendorData: string,
    callback: string,
  ): Promise<{ sessionId: string; url: string }> {
    const res = await this.fetchFn(`${this.baseURL}/session/`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id: workflowId, vendor_data: vendorData, callback }),
    });
    if (!res.ok) throw new Error(`Didit error ${res.status}`);
    const data = (await res.json()) as DiditSessionResponse;
    return { sessionId: data.session_id, url: data.url };
  }
}

/** Cliente simulado para tests y para correr el lab sin credenciales de Didit. */
export class DiditMockClient implements DiditClient {
  sesiones = new Map<string, { sessionId: string; url: string }>();

  async crearSesion(
    _workflowId: string,
    vendorData: string,
    _callback: string,
  ): Promise<{ sessionId: string; url: string }> {
    const sessionId = `didit_${vendorData}_${Date.now()}`;
    const url = `https://verification.didit.me/v3/session/${sessionId}`;
    this.sesiones.set(vendorData, { sessionId, url });
    return { sessionId, url };
  }
}
