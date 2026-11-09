import { validarTag, validarEmail } from "../domain/users";
import type {
  UserRepository,
  ComplianceProfileRepository,
  TagHistoryRepository,
} from "../domain/ports";

export interface RegistrarUsuarioInput {
  tag: string;
  email: string;
  phone_number?: string | null;
}

export interface RegistrarUsuarioOutput {
  userId: string;
  tag: string;
  email: string;
  kycStatus: string;
  accountStatus: string;
}

export class TagDuplicado extends Error {
  constructor(m: string) {
    super(m);
    this.name = "TagDuplicado";
  }
}

export class EmailDuplicado extends Error {
  constructor(m: string) {
    super(m);
    this.name = "EmailDuplicado";
  }
}

export class RegistrarUsuarioUseCase {
  constructor(
    private userRepo: UserRepository,
    private complianceRepo: ComplianceProfileRepository,
    private tagHistoryRepo: TagHistoryRepository,
  ) {}

  async ejecutar(input: RegistrarUsuarioInput): Promise<RegistrarUsuarioOutput> {
    const tag = validarTag(input.tag);
    const email = validarEmail(input.email);

    // Disponibilidad case-insensitive de tag y email
    const existente = await this.userRepo.obtenerPorTag(tag.normalizado);
    if (existente) throw new TagDuplicado(`el tag '${tag.value}' ya está en uso`);

    const existeEmail = await this.userRepo.obtenerPorEmail(email.normalizado);
    if (existeEmail) throw new EmailDuplicado(`el email '${email.value}' ya está registrado`);

    // El repositorio devuelve la fila de BD: tag y email son strings planos.
    const usuario = await this.userRepo.crear({
      id: crypto.randomUUID(),
      tag,
      email,
      phone_number: input.phone_number ?? null,
      kyc_status: "not_started",
      account_status: "active",
    });

    // Perfil de compliance 1:1 + historial de tags
    await this.complianceRepo.crearParaUsuario(usuario.id);
    await this.tagHistoryRepo.registrar(usuario.id, tag.value, "active");

    return {
      userId: usuario.id,
      tag: String(usuario.tag),
      email: String(usuario.email),
      kycStatus: usuario.kyc_status,
      accountStatus: usuario.account_status,
    };
  }
}
