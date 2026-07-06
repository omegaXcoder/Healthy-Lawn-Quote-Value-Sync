import nodemailer from 'nodemailer';

/** Emails the run log per "Claude Project Instructions" — subject must start
 * with AUTOMATION LOGGING so the recipient's filter files it automatically. */
export async function emailLog(subjectSuffix: string, body: string): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM || !SMTP_TO) {
    console.warn('SMTP env vars incomplete — skipping log email, see console/log file instead.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: SMTP_FROM,
    to: SMTP_TO,
    subject: `AUTOMATION LOGGING - Healthy Lawn NJ Quote Value Sync - ${subjectSuffix}`,
    text: body,
  });
}
