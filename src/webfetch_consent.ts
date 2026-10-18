export interface ConsentResult {
  allowed: boolean;
  reason: string;
  domain: string;
  approved: boolean; // whether domain was pre-approved
}

const approvedDomains = new Set<string>();
const deniedDomains = new Set<string>();

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function checkConsent(url: string, denyDomains: string[], allowDomains: string[]): ConsentResult {
  const domain = extractDomain(url);

  // Deny rules (checked first, always — holds even in bypass mode)
  if (denyDomains.some((d) => domain === d || domain.endsWith(`.${d}`)) || deniedDomains.has(domain)) {
    return { allowed: false, reason: `domain ${domain} is in deny list`, domain, approved: false };
  }

  // Allow list (if configured, domain must be in it)
  if (allowDomains.length > 0 && !allowDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return { allowed: false, reason: `domain ${domain} is not in allow list`, domain, approved: false };
  }

  // Shared read consent (previously approved)
  if (approvedDomains.has(domain)) {
    return { allowed: true, reason: "previously approved (shared read consent)", domain, approved: true };
  }

  return { allowed: true, reason: "no restrictions", domain, approved: false };
}

export function approveDomain(domain: string): void {
  approvedDomains.add(domain);
  deniedDomains.delete(domain);
}

export function denyDomain(domain: string): void {
  deniedDomains.add(domain);
  approvedDomains.delete(domain);
}

// Egress probe: check if URL is reachable (HEAD request)
export async function probeEgress(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    return res.ok || res.status === 405 || res.status === 403; // 403 = reachable but forbidden (host exists)
  } catch {
    return false;
  }
}

// Foreign-read consent: for subagent contexts, check if the domain is readable
export function foreignReadConsent(hasFetchRights: boolean): { allowed: boolean; reason: string } {
  if (!hasFetchRights) {
    return { allowed: false, reason: `not fetchable from here — read it with the Artifact tool in its own session` };
  }
  return { allowed: true, reason: "fetch rights available" };
}

// Summarize HTML content (strip tags, truncate)
export function summarizeContent(content: string, maxChars: number = 4000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + `\n\n[... content truncated (${content.length} chars total)]`;
}