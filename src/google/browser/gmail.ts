import type { Page } from "playwright-core";

import type { GmailDraftPayload } from "../../types/actions.js";
import type {
  GmailMessageDetail,
  GmailThreadDetail,
  GmailThreadSummary,
} from "../gmail.js";
import type { BrowserGoogleSessionManager } from "./session.js";

const GMAIL_INBOX_URL = "https://mail.google.com/mail/u/0/#inbox";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function gmailSearchUrl(query?: string): string {
  if (!query?.trim()) {
    return GMAIL_INBOX_URL;
  }

  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
}

function toThreadUrl(threadRef: string): string {
  if (/^https?:\/\//i.test(threadRef)) {
    return threadRef;
  }

  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadRef)}`;
}

async function ensureGmailPage(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);

  let host = "";
  try {
    host = new URL(page.url()).host;
  } catch {
    host = "";
  }

  if (host !== "mail.google.com") {
    const actualHost = host || "an unknown page";
    throw new Error(
      `DeskPilot could not access Gmail in the saved browser profile. Re-run \`deskpilot auth google\` while \`google.mode\` is \`browser\`, complete sign-in in the DeskPilot Chrome window, close that window, and retry. Expected mail.google.com but landed on ${actualHost}.`,
    );
  }
}

async function extractThreadLinks(page: Page, maxResults: number): Promise<string[]> {
  await page.waitForSelector("body", { timeout: 15_000 });

  return await page.evaluate((limit) => {
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="#inbox/"], a[href*="#all/"], a[href*="#search/"], a[href*="#label/"]',
      ),
    );

    const refs: string[] = [];
    const seen = new Set<string>();

    for (const anchor of anchors) {
      const href = anchor.href;
      if (!href || seen.has(href)) {
        continue;
      }

      const rect = anchor.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      seen.add(href);
      refs.push(href);
      if (refs.length >= limit) {
        break;
      }
    }

    return refs;
  }, maxResults);
}

async function expandGmailThread(page: Page): Promise<void> {
  const expandButtons = page.locator(
    'button[aria-label*="Show trimmed content"], button[aria-label*="Show more"], button[aria-label*="Expand all"]',
  );
  const count = await expandButtons.count();
  for (let index = 0; index < count; index += 1) {
    await expandButtons.nth(index).click().catch(() => undefined);
  }
}

async function extractThreadFromPage(
  page: Page,
  threadRef: string,
): Promise<GmailThreadDetail> {
  await expandGmailThread(page);

  const detail = await page.evaluate((ref) => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const subject =
      normalize(document.querySelector("h2")?.textContent) ||
      normalize(document.title.replace(/\s+-\s+Gmail$/, ""));

    const messageNodes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-message-id]"),
    );

    const messages = messageNodes.map((messageNode) => {
      const emails = Array.from(
        messageNode.querySelectorAll<HTMLElement>("[email]"),
      )
        .map((node) => node.getAttribute("email"))
        .filter((value): value is string => Boolean(value));

      const textBlocks = Array.from(
        messageNode.querySelectorAll<HTMLElement>('div[dir="auto"], div[dir="ltr"], td, pre'),
      )
        .map((node) => normalize(node.textContent))
        .filter(Boolean);

      const bodyText =
        textBlocks.sort((left, right) => right.length - left.length)[0] ||
        normalize(messageNode.textContent);

      const subjectInMessage =
        normalize(messageNode.querySelector("h2")?.textContent) || subject;
      const dateNode =
        messageNode.querySelector<HTMLElement>("time") ??
        messageNode.querySelector<HTMLElement>("[title]");
      const date =
        dateNode?.getAttribute("datetime") ??
        dateNode?.getAttribute("title") ??
        normalize(dateNode?.textContent);

      return {
        id: messageNode.getAttribute("data-message-id") ?? "",
        from: emails[0] ?? "",
        to: emails.slice(1).join(", "),
        subject: subjectInMessage,
        date,
        bodyText,
        snippet: bodyText.slice(0, 240),
      };
    });

    const threadText = normalize(document.body.textContent);
    return {
      threadId: ref,
      snippet: messages[messages.length - 1]?.snippet ?? threadText.slice(0, 240),
      messages,
    };
  }, threadRef);

  return detail as GmailThreadDetail;
}

async function getBrowserGmailThreadOnPage(
  page: Page,
  threadRef: string,
): Promise<GmailThreadDetail> {
  await ensureGmailPage(page, toThreadUrl(threadRef));
  return await extractThreadFromPage(page, threadRef);
}

async function closeComposeWindow(page: Page): Promise<void> {
  const closeButton = page.locator(
    'div[role="button"][aria-label*="Save & close"], button[aria-label*="Save & close"], button[aria-label*="Close"]',
  ).first();
  if (await closeButton.count()) {
    await closeButton.click().catch(() => undefined);
    await page.waitForTimeout(1_000);
    return;
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(1_000);
}

async function fillComposeFields(page: Page, payload: GmailDraftPayload): Promise<void> {
  const toInput = page.locator('input[aria-label*="To"], textarea[aria-label*="To"]').first();
  if (await toInput.count()) {
    await toInput.fill(payload.to.join(", "));
  }

  if (payload.cc?.length) {
    const ccTrigger = page.locator('span[role="link"]:has-text("Cc"), div[role="link"]:has-text("Cc")').first();
    if (await ccTrigger.count()) {
      await ccTrigger.click().catch(() => undefined);
      const ccInput = page.locator('input[aria-label*="Cc"]').first();
      if (await ccInput.count()) {
        await ccInput.fill(payload.cc.join(", "));
      }
    }
  }

  if (payload.bcc?.length) {
    const bccTrigger = page.locator('span[role="link"]:has-text("Bcc"), div[role="link"]:has-text("Bcc")').first();
    if (await bccTrigger.count()) {
      await bccTrigger.click().catch(() => undefined);
      const bccInput = page.locator('input[aria-label*="Bcc"]').first();
      if (await bccInput.count()) {
        await bccInput.fill(payload.bcc.join(", "));
      }
    }
  }

  const subjectInput = page.locator('input[name="subjectbox"], input[placeholder="Subject"]').first();
  if (await subjectInput.count()) {
    await subjectInput.fill(payload.subject);
  }

  const bodyEditor = page.locator('div[aria-label="Message Body"], div[role="textbox"][aria-label="Message Body"]').first();
  if (await bodyEditor.count()) {
    await bodyEditor.click();
    await bodyEditor.fill(payload.bodyText);
  }
}

async function openCompose(page: Page): Promise<void> {
  let composeButton = page.getByRole("button", { name: /compose/i }).first();
  if (!(await composeButton.count())) {
    composeButton = page.locator('div[role="button"][gh="cm"]').first();
  }

  await composeButton.click();
  await page.waitForSelector('div[aria-label="Message Body"], div[role="textbox"][aria-label="Message Body"]', {
    timeout: 15_000,
  });
}

async function attemptReplyDraft(page: Page, payload: GmailDraftPayload): Promise<boolean> {
  if (!payload.threadId) {
    return false;
  }

  await ensureGmailPage(page, toThreadUrl(payload.threadId));

  let replyButton = page.getByRole("button", { name: /^reply$/i }).first();
  if (!(await replyButton.count())) {
    replyButton = page.getByRole("button", { name: /reply to all/i }).first();
  }

  if (!(await replyButton.count())) {
    return false;
  }

  await replyButton.click();
  const bodyEditor = page.locator('div[aria-label="Message Body"], div[role="textbox"][aria-label="Message Body"]').first();
  if (!(await bodyEditor.count())) {
    return false;
  }

  await bodyEditor.click();
  await bodyEditor.fill(payload.bodyText);
  await closeComposeWindow(page);
  return true;
}

export async function listBrowserGmailThreads(
  session: BrowserGoogleSessionManager,
  options?: { query?: string; maxResults?: number },
): Promise<GmailThreadSummary[]> {
  return await session.withPage(async (page) => {
    await ensureGmailPage(page, gmailSearchUrl(options?.query));

    const threadRefs = await extractThreadLinks(page, options?.maxResults ?? 10);
    const summaries: GmailThreadSummary[] = [];

    for (const threadRef of threadRefs.slice(0, options?.maxResults ?? 10)) {
      const detail = await getBrowserGmailThreadOnPage(page, threadRef);
      const latest = detail.messages[detail.messages.length - 1];
      summaries.push({
        threadId: threadRef,
        subject: latest?.subject || "(no subject)",
        from: latest?.from || "",
        snippet: detail.snippet,
        receivedAt: latest?.date || "",
      });
    }

    return summaries;
  });
}

export async function getBrowserGmailThread(
  session: BrowserGoogleSessionManager,
  threadRef: string,
): Promise<GmailThreadDetail> {
  return await session.withPage(async (page) => {
    return await getBrowserGmailThreadOnPage(page, threadRef);
  });
}

export async function createBrowserGmailDraft(
  session: BrowserGoogleSessionManager,
  payload: GmailDraftPayload,
): Promise<{ id: string; threadId: string }> {
  return await session.withPage(async (page) => {
    const replied = await attemptReplyDraft(page, payload);
    if (!replied) {
      await ensureGmailPage(page, GMAIL_INBOX_URL);
      await openCompose(page);
      await fillComposeFields(page, payload);
      await page.waitForTimeout(1_000);
      await closeComposeWindow(page);
    }

    const opaqueId = `browser-gmail-draft:${Date.now()}`;
    return {
      id: opaqueId,
      threadId: payload.threadId ?? opaqueId,
    };
  });
}
