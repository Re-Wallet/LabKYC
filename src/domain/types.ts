export const TAG_REGEX = /^[a-z0-9._]{3,20}$/;
export const TAG_RESERVED = new Set([
  "admin", "support", "wallet", "pay", "didit", "pollar", "stellar", "oficial", "system",
]);
export const MAX_TAG_CHANGES = 2;

export class DomainError extends Error {
  constructor(message: string) { super(message); this.name = "DomainError"; }
}
export class TagInvalido extends DomainError { constructor(m: string) { super(m); this.name = "TagInvalido"; } }
export class TagReservado extends DomainError { constructor(m: string) { super(m); this.name = "TagReservado"; } }
export class TagDuplicado extends DomainError { constructor(m: string) { super(m); this.name = "TagDuplicado"; } }
export class EmailDuplicado extends DomainError { constructor(m: string) { super(m); this.name = "EmailDuplicado"; } }
export class UsuarioNoEncontrado extends DomainError { constructor(m: string) { super(m); this.name = "UsuarioNoEncontrado"; } }
export class UsuarioSinKYC extends DomainError { constructor(m: string) { super(m); this.name = "UsuarioSinKYC"; } }
export class CuentaNoActiva extends DomainError { constructor(m: string) { super(m); this.name = "CuentaNoActiva"; } }

export interface TagVO {
  value: string;
  normalizado: string;
}
export interface EmailVO {
  value: string;
  normalizado: string;
}

export interface User {
  id: string;
  tag: TagVO;
  email: EmailVO;
  phone_number?: string | null;
  full_name?: string | null;
  kyc_status: string;
  account_status: string;
}
