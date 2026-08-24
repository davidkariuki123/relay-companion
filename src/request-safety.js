const PERMISSIONS = [
  {
    id: "shell",
    label: "Run commands",
    patterns: [/\b(shell|terminal|command|script|powershell|bash|execute|run npm|run tests?|cli)\b/i],
    effect: "Commands can change this computer, install software, or start other programs.",
  },
  {
    id: "filesystem",
    label: "Read or change files",
    patterns: [/\b(file|folder|directory|repo(?:sitory)?|codebase|document|attachment|edit|write|delete|rename|move|copy)\b/i],
    effect: "File access can read private work or change and remove things on this computer.",
  },
  {
    id: "network",
    label: "Use the internet",
    patterns: [/\b(internet|web|website|browse|download|upload|api|http|url|deploy|cloud)\b/i],
    effect: "Internet access can fetch outside information or send information away from this computer.",
  },
  {
    id: "communication",
    label: "Contact other people",
    patterns: [/\b(send|email|message|relay|reply|post|publish|share|invite|notify)\b/i],
    effect: "This can speak or share something in your name, so the final wording may matter.",
  },
  {
    id: "accounts",
    label: "Use connected accounts",
    patterns: [/\b(gmail|calendar|slack|github|drive|dropbox|connector|account|workspace|oauth)\b/i],
    effect: "A connected account may reveal information or let the agent make changes in another service.",
  },
  {
    id: "software",
    label: "Change software or settings",
    patterns: [/\b(install|uninstall|upgrade|update|configure|setting|dependency|package|database|migration)\b/i],
    effect: "Software or setting changes can make an app behave differently or temporarily stop working.",
  },
  {
    id: "secrets",
    label: "Handle secrets or sign-in details",
    patterns: [/\b(secret|password|credential|token|api key|private key|login|sign[ -]?in|authentication|authorization)\b/i],
    effect: "Secrets can unlock accounts. They should not be copied, exposed, or sent somewhere unexpected.",
  },
];

const WARNING_SIGNALS = [
  { id: "destructive", pattern: /\b(delete all|erase|wipe|drop (?:the )?(?:database|table)|reset --hard|remove permanently|destroy)\b/i },
  { id: "security_bypass", pattern: /\b(disable security|bypass|ignore (?:the )?(?:warning|permission|safety)|turn off protection|without (?:asking|approval))\b/i },
  { id: "secret_exposure", pattern: /\b(send|upload|post|share|copy)\b[\s\S]{0,80}\b(secret|password|credential|token|private key|api key)\b/i },
  { id: "concealment", pattern: /\b(do not tell|hide this|silently|without (?:the )?user knowing|cover (?:it|this) up)\b/i },
];

function requestText(request) {
  const attachmentNames = (Array.isArray(request?.attachments) ? request.attachments : [])
    .map((item) => String(item?.name || ""))
    .filter(Boolean);
  return [request?.title, request?.forHuman, request?.forAgent, ...attachmentNames]
    .map((value) => String(value || ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * A local, advisory preflight over already-decrypted Task text. It never
 * calls Relay's API and never grants a permission; Accept remains one explicit
 * human consent for the selected provider's actual permission mode.
 */
export function reviewRequestSafety(request) {
  if ((request?.kind || request?.relayNotificationKind) !== "task") {
    throw new Error("Safety review is available only for Tasks.");
  }
  const text = requestText(request);
  const permissions = PERMISSIONS
    .filter((permission) => permission.patterns.some((pattern) => pattern.test(text)))
    .map(({ id, label, effect }) => ({ id, label, effect }));
  const warnings = WARNING_SIGNALS.filter((signal) => signal.pattern.test(text)).map((signal) => signal.id);
  const concern = warnings.length >= 2 ? "high" : warnings.length === 1 ? "review" : "normal";
  const summary = concern === "high"
    ? "This Task contains more than one risky instruction. Check that the exact ask is really what you expect before accepting."
    : concern === "review"
      ? "One part deserves a closer look. It may be legitimate, but make sure it matches what you expect from the sender."
      : permissions.length
        ? "Nothing clearly harmful stands out. The Task may still use the access listed below, so accept only if the Task makes sense to you."
        : "Nothing clearly harmful or powerful stands out. It looks like the agent may only need to think and write an answer.";
  return {
    version: 1,
    concern,
    summary,
    permissions,
    warnings,
    plainLanguage: permissions.length
      ? "Think of Accept like lending the agent the tools below for this job. It should use only what the job needs."
      : "This looks like a thinking job. Accept still starts an agent, but the words do not suggest it needs powerful tools.",
    advisory: "This is a local preflight, not a guarantee. The selected agent's real permission mode remains the enforcement boundary.",
    trustContext: "Accept means you trust this Task from the person who sent it and the agent acting for them. It does not require you to trust Relay with the message, because Relay cannot read it.",
  };
}
