import mjml2html from "mjml";
import { APP_URI, AWS_SES_CONFIGURATION_SET } from "../app/constants";
import { ses } from "../util/ses";

export class EmailService {
  public static async send({
    from,
    to,
    content,
    reply,
    headers,
    attachments,
  }: {
    from: {
      name: string;
      email: string;
    };
    reply?: string;
    to: string[];
    content: {
      subject: string;
      html: string;
    };
    headers?: {
      [key: string]: string;
    } | null;
    attachments?: Array<{
      filename: string;
      content: string;
      contentType: string;
    }> | null;
  }) {
    // Check if the body contains an unsubscribe link
    const regex = /unsubscribe\/([a-f\d-]+)"/;
    const containsUnsubscribeLink = content.html.match(regex);

    let unsubscribeLink = "";
    if (containsUnsubscribeLink?.[1]) {
      const unsubscribeId = containsUnsubscribeLink[1];
      unsubscribeLink = `List-Unsubscribe: <https://${APP_URI}/unsubscribe/${unsubscribeId}>`;
    }

    // Generate a unique boundary for multipart messages
    const boundary = `----=_NextPart_${Math.random().toString(36).substring(2)}`;
    const mixedBoundary = attachments?.length ? `----=_MixedPart_${Math.random().toString(36).substring(2)}` : null;

    const rawMessage = `From: ${from.name} <${from.email}>
To: ${to.join(", ")}
Reply-To: ${reply || from.email}
Subject: ${content.subject}
MIME-Version: 1.0
${mixedBoundary
        ? `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
        : `Content-Type: multipart/alternative; boundary="${boundary}"`
      }
${headers
        ? Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n")
        : ""
      }
${unsubscribeLink}

${mixedBoundary ? `--${mixedBoundary}\n` : ""}${mixedBoundary
        ? `Content-Type: multipart/alternative; boundary="${boundary}"\n\n`
        : ""
      }--${boundary}
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: 7bit

${EmailService.breakLongLines(content.html, 500)}
--${boundary}--
${attachments?.length
        ? attachments.map(attachment => `
--${mixedBoundary}
Content-Type: ${attachment.contentType}
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="${attachment.filename}"

${EmailService.breakLongLines(attachment.content, 76, true)}
`).join('\n')
        : ""
      }${mixedBoundary ? `\n--${mixedBoundary}--` : ""}`;

    const response = await ses.sendRawEmail({
      Destinations: to,
      ConfigurationSetName: AWS_SES_CONFIGURATION_SET,
      RawMessage: {
        Data: new TextEncoder().encode(rawMessage),
      },
      Source: `${from.name} <${from.email}>`,
    });

    if (!response.MessageId) {
      throw new Error("Could not send email");
    }

    return { messageId: response.MessageId };
  }

public static compile({
  content,
  footer,
  contact,
  project,
  isHtml,
}: {
  content: string;
  project: { name: string };
  contact: { id: string };
  footer: { unsubscribe?: boolean };
  isHtml?: boolean;
}) {
  const baseUri = APP_URI.startsWith("https://") ? APP_URI : `https://${APP_URI}`;
  const unsubUrl = `${baseUri}/unsubscribe/${contact.id}`;
  const unsubAnchor = `<a href="${unsubUrl}" target="_blank">update your preferences</a>`;

  // preserve existing <img> tweak, then inject unsubscribe link
  const html0 = content.replace(/<img/g, "<img");
  const hasUnsubToken = /\{\{\s*unsubscribe\s*}}/i.test(html0);
  const html = html0.replace(/\{\{\s*unsubscribe\s*}}/gi, unsubUrl);

  if (isHtml) {
    // (optional) only append footer if user didn't place {{unsubscribe}} themselves
    const maybeFooter =
      footer.unsubscribe && !hasUnsubToken
        ? `
<table align="center" width="100%" style="max-width: 480px; width: 100%; margin-left: auto; margin-right: auto; font-family: Inter, ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'; border: 0; cellpadding: 0; cellspacing: 0;" role="presentation">
  <tbody>
    <tr>
      <td>
        <hr style="border: none; border-top: 1px solid #eaeaea; width: 100%; margin-top: 12px; margin-bottom: 12px;">
        <p style="font-size: 12px; line-height: 24px; margin: 16px 0; text-align: center; color: rgb(64, 64, 64);">
          You received this email because you agreed to receive emails from ${project.name}. If you no longer wish to receive emails like this, please ${unsubAnchor}.
        </p>
      </td>
    </tr>
  </tbody>
</table>`
        : "";
    return `${html}\n\n${maybeFooter}`;
  }

  // MJML path
  return mjml2html(
    `<mjml>
      <mj-head> ... (unchanged styles) ... </mj-head>
      <mj-body>
        <mj-section>
          <mj-column>
            <mj-raw>
              <tr class="prose prose-neutral">
                <td style="padding:10px 25px;word-break:break-word">
                  ${html}
                </td>
              </tr>
            </mj-raw>
          </mj-column>
        </mj-section>
        ${
          footer.unsubscribe && !hasUnsubToken
            ? `
        <mj-section>
          <mj-column>
            <mj-divider border-width="2px" border-color="#f5f5f5"></mj-divider>
            <mj-text align="center">
              <p style="color: #a3a3a3; text-decoration: none; font-size: 12px; line-height: 1.7142857;">
                You received this email because you agreed to receive emails from ${project.name}. If you no longer wish to receive emails like this, please ${unsubAnchor}.
              </p>
            </mj-text>
          </mj-column>
        </mj-section>`
            : ""
        }
      </mj-body>
    </mjml>`
  ).html.replace(/^\s+|\s+$/g, "");
}

  public static format({ subject, body, data }: { subject: string; body: string; data: Record<string, any> }) {
    const replaceFn = (isBody = false) => (match: string, key: string) => {
      const [mainKey, defaultValue] = key.split("??").map((s: string) => s.trim());
      if (mainKey.toLowerCase() === "unsubscribe") return match; // <-- keep placeholder
      const val = data[mainKey] ?? defaultValue ?? "";
      if (isBody && Array.isArray(val)) return val.map((e: string) => `<li>${e}</li>`).join("\n");
      return val;
    };

    return {
      subject: subject.replace(/\{\{(.*?)}}/g, replaceFn(false)),
      body: body.replace(/\{\{(.*?)}}/g, replaceFn(true)),
    };
  }

  private static breakLongLines(input: string, maxLineLength: number, isBase64: boolean = false): string {
    if (isBase64) {
      // For base64 content, break at exact intervals without looking for spaces
      const result = [];
      for (let i = 0; i < input.length; i += maxLineLength) {
        result.push(input.substring(i, i + maxLineLength));
      }
      return result.join("\n");
    } else {
      // Original implementation for text content
      const lines = input.split("\n");
      const result = [];
      for (let line of lines) {
        while (line.length > maxLineLength) {
          let pos = maxLineLength;
          while (pos > 0 && line[pos] !== " ") {
            pos--;
          }
          if (pos === 0) {
            pos = maxLineLength;
          }
          result.push(line.substring(0, pos));
          line = line.substring(pos).trim();
        }
        result.push(line);
      }
      return result.join("\n");
    }
  }
}
