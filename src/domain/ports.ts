export interface UserRow {
  id: string;
  tag: string;
  email: string;
  kyc_status: string;
  account_status: string;
}

export interface UserRepository {
  obtenerPorId(userId: string): Promise<UserRow | null>;
  obtenerPorTag(tagNormalizado: string): Promise<UserRow | null>;
  obtenerPorEmail(emailNormalizado: string): Promise<UserRow | null>;
  crear(usuario: {
    id: string;
    tag: { value: string; normalizado: string };
    email: { value: string; normalizado: string };
    phone_number?: string | null;
    kyc_status: string;
    account_status: string;
  }): Promise<UserRow>;
  actualizarKycStatus(userId: string, status: string): Promise<void>;
  actualizarDatosKYC(userId: string, datos: DatosKYC): Promise<void>;
}

export interface DatosKYC {
  fullName?: string | null;
  dateOfBirth?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  documentExpiry?: string | null;
  nationality?: string | null;
}

export interface ComplianceProfileRepository {
  crearParaUsuario(userId: string): Promise<void>;
}

export interface TagHistoryRepository {
  registrar(userId: string, tag: string, status?: string): Promise<void>;
}
