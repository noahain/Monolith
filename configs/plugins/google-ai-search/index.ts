import type { Plugin } from "@opencode-ai/plugin"
import TurndownService from "turndown"

type PlaywrightModule = typeof import("playwright")

type Browser = Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 120_000

export const GoogleAISearchPlugin: Plugin = async ({ Tool, z }) => {
  const GoogleAITool = Tool.define("google_ai_search_plus", {
    description: "Search the web using Google's AI-powered search mode. This tool provides comprehensive, AI-enhanced search results with contextual information, summaries, and source references. Use this for any web searches, current events, factual lookups, research questions, or when you need up-to-date information beyond your knowledge cutoff. Returns structured markdown responses with sources.",
    parameters: z
      .object({
        query: z.string().describe("Question or topic to submit to Google AI Mode"),
        timeout: z
          .number()
          .min(5)
          .max(120)
          .optional()
          .describe("Timeout in seconds (default: 30, max: 120)"),
        followUp: z
          .boolean()
          .optional()
          .describe("Treat the query as a follow-up in the same session")
      })
      .describe("Parameters for google_ai_search_plus"),
    async execute(params: any, ctx: any) {
      const playwright = await loadPlaywright()
      const manager = new GoogleAIModeManager(playwright)
      const timeoutMs = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

      const abortHandler = () => {
        manager.dispose().catch(() => undefined)
      }
      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      try {
        const result = await manager.query(params.query, params.followUp ?? false, timeoutMs, ctx.abort)

        ctx.metadata({
          title: `Google AI: ${params.query}`,
          metadata: {
            query: params.query,
            sourceCount: result.sources.count,
            responseTime: result.metadata.responseTime,
            hasTable: result.tableData.length > 0,
          },
        })

        return {
          title: `Google AI Mode: ${params.query}`,
          output: formatAIResponse(result),
          metadata: {
            query: result.query,
            responseTime: result.metadata.responseTime,
            sources: result.sources,
            hasTable: result.tableData.length > 0,
          },
        }
      } catch (error) {
        const message = (error as Error).message
        if (message.includes("Timeout") || message.includes("forSelector")) {
          throw new Error("Google AI Mode unavailable: automated access is currently blocked. This is expected behaviour.")
        }
        throw error
      } finally {
        ctx.abort.removeEventListener("abort", abortHandler)
        await manager.dispose()
      }
    },
  })

  return {
    async ["tool.register"](_input, { register }) {
      register(GoogleAITool)
    },
  }
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import("playwright")
  } catch (error) {
    try {
      return await import("/tmp/node_modules/playwright")
    } catch {
      throw new Error(
        "google_ai_search_plus requires Playwright. Install it with: bun install playwright && bunx playwright install chromium",
        { cause: error },
      )
    }
  }
}

class GoogleAIModeManager {
  private browser: Browser | null = null
  private page: Page | null = null
  private conversationActive = false
  private sessionStartTime = Date.now()
  private readonly SESSION_TIMEOUT = 5 * 60 * 1000

  constructor(private readonly playwright: PlaywrightModule) {}

  async query(query: string, followUp: boolean, timeout: number, abortSignal: AbortSignal): Promise<AIResponse> {
    if (Date.now() - this.sessionStartTime > this.SESSION_TIMEOUT) {
      await this.reset()
    }

    await this.ensureBrowserSession()

    if (!followUp || !this.conversationActive) {
      await this.navigateToAIMode()
      this.conversationActive = true
    }

    return await this.submitQuery(query, timeout, abortSignal)
  }

  private async ensureBrowserSession() {
    if (!this.browser) {
      this.browser = await this.playwright.chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-features=VizDisplayCompositor",
        ],
      })
    }

    if (!this.page) {
      this.page = await this.browser.newPage({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      })

      await this.page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => false,
        })

        const chrome = (window as any).chrome
        if (chrome?.runtime?.onConnect) {
          delete chrome.runtime.onConnect
        }

        Object.defineProperty(navigator, "languages", {
          get: () => ["en-GB", "en-US", "en"],
        })
      })
    }
  }

  private async navigateToAIMode() {
    if (!this.page) throw new Error("Page not initialized")
    await this.page.goto("https://www.google.com")
    await this.page.waitForTimeout(2000)
  }

  private buildAIModeURL(query?: string): string {
    const baseURL = "https://www.google.com/search"
    const params = new URLSearchParams({
      udm: "50",
      aep: "22",
      q: query ?? "",
      hl: "en",
    })
    return `${baseURL}?${params.toString()}`
  }

  private async submitQuery(query: string, timeout: number, abortSignal: AbortSignal): Promise<AIResponse> {
    if (!this.page) throw new Error("Page not initialized")

    const startTime = Date.now()
    const aiModeUrl = this.buildAIModeURL(query)

    await this.page.goto(aiModeUrl, { waitUntil: "networkidle", timeout })

    if (this.page.url().includes("/sorry/")) {
      throw new Error("Google is blocking automated access.")
    }

    await this.page.waitForTimeout(3000)

    let previousLength = 0
    let stableCount = 0
    const waitStartTime = Date.now()
    const maxWaitTime = timeout

    while (Date.now() - waitStartTime < maxWaitTime) {
      await this.page.waitForTimeout(2000)

      const currentLength = await this.page.evaluate(() => document.body.textContent?.length ?? 0)

      if (currentLength === previousLength) {
        stableCount += 1
        if (stableCount >= 3) {
          break
        }
      } else {
        stableCount = 0
      }

      previousLength = currentLength
    }

    const hasContent = await this.page.evaluate(() => {
      const body = document.body.textContent ?? ""
      return (
        body.includes("AI responses may include mistakes") ||
        !!document.querySelector("table") ||
        body.length > 10_000
      )
    })

    if (!hasContent) {
      throw new Error("AI content did not load")
    }

    const response = await this.parseResponse(query, Date.now() - startTime)

    if (abortSignal.aborted) {
      throw new Error("Operation aborted")
    }

    return response
  }

  private async parseResponse(query: string, responseTime: number): Promise<AIResponse> {
    if (!this.page) throw new Error("Page not initialized")

    const extraction = await this.page.evaluate(() => {
      const clean = (text?: string | null) => {
        if (!text) return ""
        return text
          .replace(/\u00a0/g, " ")
          .replace(/\r\n?/g, "\n")
          .replace(/[\t ]+\n/g, "\n")
          .replace(/\n[\t ]+/g, "\n")
          .replace(/[ \t]{2,}/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/\s([,:;.!?])/g, "$1")
          .trim()
      }

      const root =
        (document.querySelector('[data-aimmrs="true"]') as HTMLElement | null) ||
        (document.querySelector("#aim-chrome-initial-inline-async-container") as HTMLElement | null) ||
        (document.querySelector('[data-aim-chrome-rendered="true"]') as HTMLElement | null) ||
        document.body

      const main = (root.querySelector(".mZJni.Dn7Fzd") as HTMLElement | null) || root
      const contentContainer = (main.querySelector(".Zkbeff") as HTMLElement | null) || main

      const blockSelectors =
        "[role=\"heading\"], h1, h2, h3, h4, h5, h6, .Y3BBE, .Fv6NCb, table, ul, ol, p"
      const orderedNodes = Array.from(
        contentContainer.querySelectorAll(blockSelectors),
      ) as HTMLElement[]

      const blocks: Array<any> = []
      const listHeadingMarkers = new Set<HTMLElement>()
      const paragraphTexts = new Set<string>()
      let summary = ""
      let tableBlock: { header: string[]; rows: string[][] } | null = null

      const shouldSkipText = (text: string) => {
        if (!text) return true
        if (/AI responses may include mistakes/i.test(text)) return true
        if (/learn more$/i.test(text)) return true
        return false
      }

      orderedNodes.forEach((node) => {
        const text = clean(node.innerText)
        if (shouldSkipText(text)) {
          return
        }

        if (node.classList.contains("otQkpb") || node.matches("[role=\"heading\"], h1, h2, h3, h4, h5, h6")) {
          const level = parseInt(node.getAttribute("aria-level") || "3", 10)
          blocks.push({ type: "heading", text, level })
          return
        }

        if (node.classList.contains("Fv6NCb")) {
          const table = node.querySelector("table")
          if (table) {
            const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
              Array.from(row.querySelectorAll("th,td")).map((cell) => clean((cell as HTMLElement).innerText)),
            ).filter((row) => row.some((cell) => cell))

            if (rows.length > 1) {
              tableBlock = {
                header: rows[0],
                rows: rows.slice(1),
              }
              blocks.push({ type: "table" })
            }
          }
          return
        }

        if (node.tagName === "UL" || node.tagName === "OL") {
          const items = Array.from(node.querySelectorAll(":scope > li"))
            .map((li) => clean((li as HTMLElement).innerText))
            .filter(Boolean)

          if (items.length === 0) return

          let heading: string | undefined
          const prev = node.previousElementSibling as HTMLElement | null
          if (prev && listHeadingMarkers.has(prev)) {
            heading = clean(prev.innerText).replace(/:\s*$/, "")
          }

          blocks.push({
            type: "list",
            ordered: node.tagName === "OL",
            heading,
            items,
          })
          return
        }

        if (node.classList.contains("Y3BBE") || node.tagName === "P") {
          if (node.tagName === "P" && node.closest("li")) {
            return
          }
          if (!summary) {
            summary = text
          }

          const next = node.nextElementSibling
          if (next && (next.tagName === "UL" || next.tagName === "OL")) {
            listHeadingMarkers.add(node)
            return
          }

          if (!paragraphTexts.has(text)) {
            paragraphTexts.add(text)
            blocks.push({ type: "paragraph", text })
          }
        }
      })

      if (!summary) {
        summary = clean(contentContainer.innerText.split("\n").find(Boolean) || "")
      }

      const rawHtml = contentContainer.innerHTML
      const rawText = clean(contentContainer.innerText)
      const fallbackParagraphs = rawText
        .split(/\n{2,}/)
        .map((part) => clean(part))
        .filter((value) => value.length > 0)

      const consentIndicators = [
        "Before you continue to Google Search",
        "We use cookies",
        "By using our services, you agree",
        "We value your privacy",
      ]
      const isConsent = consentIndicators.some((phrase) => root.innerText.includes(phrase))

      const sourceContainer = root.querySelector(".ofHStc") as HTMLElement | null
      let sourceCount = 0
      const sources: Array<{ title: string; url?: string; publisher?: string }> = []
      let hasVideo = false

      if (sourceContainer) {
        const countMatch = sourceContainer.innerText.match(/(\d+)\s+sites?/i)
        if (countMatch) {
          sourceCount = parseInt(countMatch[1], 10)
        }

        const list = sourceContainer.querySelector("ul")
        if (list) {
          const seenLinks = new Set<string>()
          Array.from(list.querySelectorAll(":scope > li")).forEach((li) => {
            const itemText = clean((li as HTMLElement).innerText)
            const link = (li.querySelector("a") as HTMLAnchorElement | null)?.href || undefined
            if (/sites?$/i.test(itemText)) {
              return
            }
            if (link) {
              if (seenLinks.has(link)) return
              seenLinks.add(link)
            }
            const lines = itemText.split("\n").map((part) => part.trim()).filter(Boolean)
            const titleLine = lines[0] || itemText
            if (/YouTube/i.test(itemText)) {
              hasVideo = true
            }
            const publisherMatch = lines.length > 1 ? lines[lines.length - 1] : undefined
            sources.push({
              title: titleLine,
              url: link,
              publisher: publisherMatch && publisherMatch !== titleLine ? publisherMatch : undefined,
            })
          })
        }
      }

      if (!sourceCount && sources.length > 0) {
        sourceCount = sources.length
      }

      return {
        summary,
        blocks,
        table: tableBlock,
        rawHtml,
        rawText,
        fallbackParagraphs,
        isConsent,
        sources: {
          count: sourceCount,
          entries: sources,
          hasVideo,
        },
      }
    })

    const answerSections: string[] = []
    const tableRows: ComparisonRow[] = []
    const tableHeaders = (((extraction.table as any)?.header ?? []) as string[]).slice(0, 3)

    extraction.blocks?.forEach((block: any) => {
      if (!block || !block.type) return

      if (block.type === "heading" && block.text) {
        const level = Math.min(6, Math.max(3, (block.level as number) || 3))
        const prefix = "#".repeat(level)
        answerSections.push(`${prefix} ${block.text}`)
        return
      }

      if (block.type === "paragraph" && block.text) {
        answerSections.push(block.text)
        return
      }

      if (block.type === "list" && Array.isArray(block.items)) {
        if (block.heading) {
          answerSections.push(`**${block.heading}:**`)
        }
        block.items.forEach((item: string) => {
          answerSections.push(`- ${item}`)
        })
        return
      }

      if (block.type === "table" && extraction.table) {
        const headers = (((extraction.table as any).header || []) as string[]).slice(0, 3)
        const rows = ((extraction.table as any).rows || []) as string[][]
        if (headers.length >= 2 && rows.length > 0) {
          const headerLine = `| ${headers.join(" | ")} |`
          const separator = `|${headers.map(() => "---").join("|")}|`
          const body = rows.map((row: string[]) => `| ${headers.map((_, idx) => row[idx] || "").join(" | ")} |`)

          answerSections.push(headerLine)
          answerSections.push(separator)
          answerSections.push(...body)

          rows.forEach((row: string[]) => {
            tableRows.push({
              feature: row[0] || "",
              column1: row[1] || "",
              column2: row[2] || "",
            })
          })
        }
      }
    })

    const summary = extraction.summary || ""
    if (summary && !answerSections.find((section) => section.includes(summary))) {
      answerSections.unshift(summary)
    }

    const formattedAnswer = answerSections
      .filter((section) => section && section.trim())
      .join("\n\n")

    const sourceEntries = (extraction.sources?.entries ?? []) as SourceReference[]
    const sourceNames = sourceEntries
      .map((entry) => entry.publisher)
      .filter((name): name is string => Boolean(name))
    const uniqueSites = Array.from(new Set(sourceNames))

    let finalAnswer = formattedAnswer

    const fallbackContent = (extraction.fallbackParagraphs ?? [])
      .filter((paragraph: string) => paragraph.length > 40)
      .filter((paragraph: string) => !finalAnswer.includes(paragraph.slice(0, Math.min(60, paragraph.length))))

    if ((!finalAnswer || finalAnswer.length < 500) && fallbackContent.length > 0) {
      const fallbackBlock = fallbackContent.join("\n\n")
      finalAnswer = finalAnswer ? `${finalAnswer}\n\n---\n${fallbackBlock}` : fallbackBlock
    }

    if (extraction.isConsent) {
      finalAnswer = formattedAnswer || extraction.rawText || finalAnswer
    }

    let markdownAnswer = ""
    const turndownService = new TurndownService({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
    })
    turndownService.remove(["script", "style", "meta", "link"])

    if (extraction.rawHtml) {
      try {
        markdownAnswer = turndownService.turndown(extraction.rawHtml)
      } catch {
        markdownAnswer = ""
      }
    }

    if (markdownAnswer && fallbackContent.length > 0) {
      const fallbackBlock = fallbackContent.join("\n\n")
      if (fallbackBlock && !markdownAnswer.includes(fallbackBlock.slice(0, Math.min(80, fallbackBlock.length)))) {
        markdownAnswer = `${markdownAnswer}\n\n---\n${fallbackBlock}`
      }
    }

    if (!markdownAnswer || markdownAnswer.trim().length < 200) {
      markdownAnswer = finalAnswer
    }

    if (!markdownAnswer && extraction.rawText) {
      markdownAnswer = extraction.rawText
    }

    return {
      query,
      answer: markdownAnswer || summary || `Google AI response for: ${query}`,
      summary,
      tableData: tableRows,
      tableHeaders,
      sources: {
        count: extraction.sources?.count ?? sourceEntries.length,
        hasVideo: Boolean(extraction.sources?.hasVideo),
        sites: uniqueSites,
        references: sourceEntries,
      },
      metadata: {
        responseTime,
        conversationIndex: this.conversationActive ? 2 : 1,
        sessionId: `session_${this.sessionStartTime}`,
        timestamp: new Date(),
      },
    }
  }

  async reset() {
    this.conversationActive = false
    this.sessionStartTime = Date.now()
    try {
      if (this.page) {
        await this.page.getByRole("button", { name: "Start new search" }).click({ timeout: 2000 })
      }
    } catch {
      if (this.page) {
        await this.page.goto("https://www.google.com", { waitUntil: "load" })
      }
    }
  }

  async dispose() {
    if (this.page) {
      await this.page.close().catch(() => undefined)
      this.page = null
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined)
      this.browser = null
    }
    this.conversationActive = false
  }
}

function formatAIResponse(response: AIResponse): string {
  let output = `# ${response.query}\n\n`

  if (response.summary && response.summary !== response.answer) {
    output += `**Summary**: ${response.summary}\n\n`
  }

  output += `## Answer\n\n${response.answer}\n\n`

  if (response.tableData && response.tableData.length > 0) {
    const headers = response.tableHeaders && response.tableHeaders.length >= 3
      ? response.tableHeaders.slice(0, 3)
      : ["Feature", "Option 1", "Option 2"]
    const signature = `| ${headers[0]} | ${headers[1]} |`
    const alreadyPresent = response.answer.includes(signature)

    if (!alreadyPresent) {
      output += `## Comparison Table\n\n`
      output += `| ${headers.join(" | ")} |\n`
      output += `|${headers.map(() => "---").join("|")}|\n`
      response.tableData.forEach((row) => {
        const values = [row.feature, row.column1, row.column2]
        output += `| ${headers.map((_, idx) => values[idx] || "").join(" | ")} |\n`
      })
      output += "\n"
    }
  }

  output += "## Sources\n\n"
  output += `- **Sources Referenced**: ${response.sources.count} sites\n`
  if (response.sources.hasVideo) {
    output += "- **Includes Video Sources**: Yes\n"
  }
  output += `- **Response Time**: ${response.metadata.responseTime}ms\n`
  output += `- **Session**: ${response.metadata.sessionId}\n`

  if (response.sources.references && response.sources.references.length > 0) {
    output += "- **Source Links:**\n"
    response.sources.references.forEach((ref) => {
      if (!ref?.title) return
      const label = ref.url ? `[${ref.title}](${ref.url})` : ref.title
      output += `  - ${label}\n`
    })
  }

  return output
}

type SourceReference = {
  title: string
  url?: string
  publisher?: string
}

type AIResponse = {
  query: string
  answer: string
  summary?: string
  tableData: ComparisonRow[]
  tableHeaders: string[]
  sources: {
    count: number
    hasVideo: boolean
    sites: string[]
    references: SourceReference[]
  }
  metadata: {
    responseTime: number
    conversationIndex: number
    sessionId: string
    timestamp: Date
  }
}

type ComparisonRow = {
  feature: string
  column1: string
  column2: string
}
