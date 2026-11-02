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

export function getMailer(source: NodeJS.ProcessEnv = process.env): Mailer | null {
  return source.NODE_ENV === "development" || source.NODE_ENV === "test" ? new ConsoleMailer() : null;
}
