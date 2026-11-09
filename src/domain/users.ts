import { TagInvalido, TagReservado, TAG_REGEX, TAG_RESERVED, TagVO, EmailVO } from "./types";

export function validarTag(tag: string): TagVO {
  const normalizado = tag.toLowerCase();
  if (!TAG_REGEX.test(normalizado)) {
    throw new TagInvalido(`tag '${tag}' no cumple el formato ${TAG_REGEX}`);
  }
  if (TAG_RESERVED.has(normalizado)) {
    throw new TagReservado(`tag '${tag}' está reservado`);
  }
  return { value: normalizado, normalizado };
}

export function validarEmail(email: string): EmailVO {
  const normalizado = email.toLowerCase();
  if (!normalizado.includes("@")) throw new Error("email inválido");
  return { value: normalizado, normalizado };
}
