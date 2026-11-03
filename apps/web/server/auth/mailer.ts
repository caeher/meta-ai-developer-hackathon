import nodemailer from "nodemailer";

export interface Mailer {
  sendVerificationEmail(input: { email: string; url: string }): Promise<void>;
  sendPasswordResetEmail(input: { email: string; url: string }): Promise<void>;
}

/** Console delivery is intended for local development only. The URL is the delivered message body. */
export class ConsoleMailer implements Mailer {
  async sendVerificationEmail(input: { email: string; url: string }): Promise<void> {
    console.info("[development mail] verification message prepared", { to: input.email, url: input.url });
  }

  async sendPasswordResetEmail(input: { email: string; url: string }): Promise<void> {
    console.info("[development mail] password reset message prepared", { to: input.email, url: input.url });
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;
  private readonly from: string;

  constructor(source: NodeJS.ProcessEnv = process.env) {
    const host = source.SMTP_HOST?.trim();
    if (!host) throw new Error("SMTP_HOST is required for SMTP mail delivery");
    const port = Number(source.SMTP_PORT ?? 1025);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT must be a valid TCP port");
    const user = source.SMTP_USER?.trim();
    const pass = source.SMTP_PASSWORD;
    this.from = source.SMTP_FROM?.trim() || "Forja <no-reply@localhost>";
    this.transport = nodemailer.createTransport({
      host,
      port,
      secure: source.SMTP_SECURE === "true",
      requireTLS: source.NODE_ENV === "production" && source.SMTP_SECURE !== "true",
      ...(user && pass ? { auth: { user, pass } } : {}),
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  async sendVerificationEmail(input: { email: string; url: string }): Promise<void> {
    await this.send(input.email, "Verifica tu correo para Forja", "Confirma tu correo electrónico para activar tu cuenta:", input.url);
  }

  async sendPasswordResetEmail(input: { email: string; url: string }): Promise<void> {
    await this.send(input.email, "Restablece tu contraseña de Forja", "Usa este enlace para elegir una contraseña nueva:", input.url);
  }

  private async send(to: string, subject: string, intro: string, url: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text: `${intro}\n\n${url}\n\nSi no solicitaste este mensaje, puedes ignorarlo.` });
  }
}

export function getMailer(source: NodeJS.ProcessEnv = process.env): Mailer | null {
  if (source.SMTP_HOST?.trim()) return new SmtpMailer(source);
  return source.NODE_ENV === "development" || source.NODE_ENV === "test" ? new ConsoleMailer() : null;
}
