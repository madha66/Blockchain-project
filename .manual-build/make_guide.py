"""Builds docs/GigLend_User_Guide_and_Manual_Tests.pdf (tutorial with screenshots + manual tests)."""
import os
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, Image, KeepTogether, PageBreak, PageTemplate,
    Paragraph, Spacer, Table, TableStyle,
)

HERE = os.path.dirname(os.path.abspath(__file__))
PNG = os.path.join(HERE, "png")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "docs", "GigLend_User_Guide_and_Manual_Tests.pdf")

FONTS = "C:/Windows/Fonts/"
pdfmetrics.registerFont(TTFont("Arial", FONTS + "arial.ttf"))
pdfmetrics.registerFont(TTFont("Arial-Bold", FONTS + "arialbd.ttf"))
pdfmetrics.registerFont(TTFont("Arial-Italic", FONTS + "ariali.ttf"))
pdfmetrics.registerFont(TTFont("Arial-BoldItalic", FONTS + "arialbi.ttf"))
pdfmetrics.registerFont(TTFont("Consolas", FONTS + "consola.ttf"))
pdfmetrics.registerFontFamily("Arial", normal="Arial", bold="Arial-Bold", italic="Arial-Italic", boldItalic="Arial-BoldItalic")

GOLD = colors.HexColor("#B8860B")
GOLD_LIGHT = colors.HexColor("#FDF6E3")
INK = colors.HexColor("#1F2328")
MUTED = colors.HexColor("#5B6470")
LINE = colors.HexColor("#D9DDE3")
CODE_BG = colors.HexColor("#F4F5F7")
GREEN_BG = colors.HexColor("#EAF7EF")
RED_BG = colors.HexColor("#FCEDEE")

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

S = {
    "title": ParagraphStyle("title", fontName="Arial-Bold", fontSize=28, leading=34, textColor=INK, spaceAfter=10),
    "subtitle": ParagraphStyle("subtitle", fontName="Arial", fontSize=13, leading=18, textColor=MUTED, spaceAfter=6),
    "part": ParagraphStyle("part", fontName="Arial-Bold", fontSize=11, leading=14, textColor=GOLD, spaceAfter=4),
    "h1": ParagraphStyle("h1", fontName="Arial-Bold", fontSize=19, leading=24, textColor=INK, spaceBefore=4, spaceAfter=8, keepWithNext=1),
    "h2": ParagraphStyle("h2", fontName="Arial-Bold", fontSize=13.5, leading=18, textColor=INK, spaceBefore=10, spaceAfter=5, keepWithNext=1),
    "h3": ParagraphStyle("h3", fontName="Arial-Bold", fontSize=11, leading=15, textColor=INK, spaceBefore=6, spaceAfter=3, keepWithNext=1),
    "body": ParagraphStyle("body", fontName="Arial", fontSize=10, leading=14.5, textColor=INK, spaceAfter=5),
    "small": ParagraphStyle("small", fontName="Arial", fontSize=8.8, leading=12, textColor=MUTED),
    "cell": ParagraphStyle("cell", fontName="Arial", fontSize=9, leading=12.2, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName="Arial-Bold", fontSize=9, leading=12.2, textColor=INK),
    "caption": ParagraphStyle("caption", fontName="Arial-Italic", fontSize=8.8, leading=12, textColor=MUTED, alignment=TA_CENTER, spaceBefore=3, spaceAfter=10),
    "code": ParagraphStyle("code", fontName="Consolas", fontSize=9, leading=12.5, textColor=INK),
    "bullet": ParagraphStyle("bullet", fontName="Arial", fontSize=10, leading=14.5, textColor=INK, leftIndent=14, bulletIndent=3, spaceAfter=2.5),
}

story = []


def P(text, style="body"):
    story.append(Paragraph(text, S[style]))


def bullets(items, style="bullet"):
    for it in items:
        story.append(Paragraph(it, S[style], bulletText="•"))
    story.append(Spacer(1, 4))


def numbered(items):
    for i, it in enumerate(items, 1):
        story.append(Paragraph(it, S["bullet"], bulletText=f"{i}."))
    story.append(Spacer(1, 4))


def code(lines):
    body = "<br/>".join(l.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace(" ", "&nbsp;") for l in lines)
    t = Table([[Paragraph(body, S["code"])]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODE_BG),
        ("BOX", (0, 0), (-1, -1), 0.5, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t)
    story.append(Spacer(1, 7))


def note(text, bg=GOLD_LIGHT, edge=GOLD):
    t = Table([[Paragraph(text, S["cell"])]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 3, edge),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t)
    story.append(Spacer(1, 8))


def table(rows, widths, header=True, font_rows=None):
    data = []
    for r_i, row in enumerate(rows):
        style = "cellb" if header and r_i == 0 else "cell"
        data.append([c if not isinstance(c, str) else Paragraph(c, S[style]) for c in row])
    t = Table(data, colWidths=[w * CONTENT_W for w in widths], repeatRows=1 if header else 0)
    st = [
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        st.append(("BACKGROUND", (0, 0), (-1, 0), GOLD_LIGHT))
    t.setStyle(TableStyle(st))
    story.append(t)
    story.append(Spacer(1, 8))


def shot(name, caption, width=CONTENT_W):
    path = os.path.join(PNG, f"{name}.png")
    img = Image(path)
    ratio = img.imageHeight / img.imageWidth
    img.drawWidth = width
    img.drawHeight = width * ratio
    frame = Table([[img]], colWidths=[width + 2])
    frame.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    story.append(KeepTogether([frame, Paragraph(caption, S["caption"])]))


def two_shots(a, cap_a, b, cap_b):
    col = (CONTENT_W - 12) / 2

    def cell(name, cap):
        img = Image(os.path.join(PNG, f"{name}.png"))
        ratio = img.imageHeight / img.imageWidth
        w = col
        h = w * ratio
        if h > 300:
            h = 300
            w = h / ratio
        img.drawWidth, img.drawHeight = w, h
        return [img, Paragraph(cap, S["caption"])]

    t = Table([[cell(a, cap_a), cell(b, cap_b)]], colWidths=[col + 6, col + 6])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("ALIGN", (0, 0), (-1, -1), "CENTER")]))
    story.append(t)


# ─────────────────────────────────────────────────────────────────────────────
# Page decorations
# ─────────────────────────────────────────────────────────────────────────────

def on_cover(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(GOLD)
    canvas.rect(0, PAGE_H - 10 * mm, PAGE_W, 10 * mm, stroke=0, fill=1)
    canvas.rect(0, 0, PAGE_W, 4 * mm, stroke=0, fill=1)
    canvas.restoreState()


def on_page(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, PAGE_H - 12 * mm, PAGE_W - MARGIN, PAGE_H - 12 * mm)
    canvas.setFont("Arial", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, PAGE_H - 10 * mm, "GigLend V3 · User guide and manual test plan")
    canvas.drawRightString(PAGE_W - MARGIN, 10 * mm, f"Page {doc.page}")
    canvas.drawString(MARGIN, 10 * mm, "Local testnet prototype · mock KYC, OTP and payouts")
    canvas.restoreState()


doc = BaseDocTemplate(
    OUT, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=18 * mm, bottomMargin=17 * mm,
    title="GigLend V3 — User guide and manual test plan", author="GigLend team",
    subject="How to run the GigLend website and test it by hand",
)
frame = Frame(MARGIN, 17 * mm, CONTENT_W, PAGE_H - 35 * mm, id="main")
doc.addPageTemplates([
    PageTemplate(id="cover", frames=[frame], onPage=on_cover),
    PageTemplate(id="body", frames=[frame], onPage=on_page),
])

# ─────────────────────────────────────────────────────────────────────────────
# Cover
# ─────────────────────────────────────────────────────────────────────────────
story.append(Spacer(1, 40 * mm))
P("GIGLEND V3", "part")
P("User guide and<br/>manual test plan", "title")
P("How to run the website, how it works, and eleven hands-on tests covering lenders, normal borrowers, late payers and defaulters.", "subtitle")
story.append(Spacer(1, 10 * mm))
table([
    ["Part", "What you get"],
    ["Part 1 · Tutorial", "Start the system locally, wallets and demo accounts, a guided tour of every page with screenshots, and how a loan moves from on-time to default."],
    ["Part 2 · Manual tests", "Eleven short test cases. Each one says what it proves, who to log in as, the steps, what you should see, and a pass/fail box."],
], [0.28, 0.72])
story.append(Spacer(1, 12 * mm))
note("<b>Prototype notice.</b> GigLend runs on a local Hardhat test chain. KYC, OTP codes, income and gig payouts are mocks, and all keys in this guide are public Hardhat test keys. Never use them on a real network.")
P("Prepared 25 October 2026 · branch <font face='Consolas'>feature/auth-defaulter-handling</font>", "small")
story.append(PageBreak())

# switch to body template from here on
from reportlab.platypus.doctemplate import NextPageTemplate  # noqa: E402
story.insert(len(story) - 1, NextPageTemplate("body"))

# ─────────────────────────────────────────────────────────────────────────────
# PART 1
# ─────────────────────────────────────────────────────────────────────────────
P("PART 1", "part")
P("Tutorial: running and using GigLend", "h1")

P("1. What GigLend is", "h2")
P("GigLend is a community lending pool for gig workers. <b>Lenders</b> deposit ETH and receive GLP pool shares. <b>Borrowers</b> are verified members who take small installment loans that are repaid on the same weekly or two-weekly cycle as their gig payouts. The website covers the whole policy for handling defaults:")
bullets([
    "<b>Prevent:</b> every member starts with an escrowed <i>credit-builder</i> loan; limits grow slowly; repayments must stay within 35% of income.",
    "<b>Detect early:</b> the backend watches payouts and warns before a payment is missed.",
    "<b>Cure cheaply:</b> a grace period without fees, one priced restructure per loan, autopay from a SafeRepay vault and an income sweep.",
    "<b>Recover from what is locked:</b> the borrower's stake, then a guarantor's stake, then the reserve, then lenders.",
    "<b>Book losses in steps:</b> late loans count for less in the pool's value as they get later.",
    "<b>Treat by type:</b> each default is classified as Hardship, Strategic or Fraud, with a workout, a lock-out, or a ban. The borrower can appeal within 21 days.",
    "<b>One person, one record:</b> a verified identity (stored only as a hash) is tied to one member record, so a new wallet cannot escape an old default.",
])

P("2. The pieces", "h2")
table([
    ["Part", "Runs on", "What it does"],
    ["Local blockchain", "Hardhat node · port 8545", "Holds all contracts and money. Chain time can be moved forward for testing."],
    ["Smart contracts", "Deployed by <font face='Consolas'>npm run deploy:local</font>", "Pool, loans, prevention rules, defaults, identity registry, credit score, reserve, SafeRepay vault, mock payout router."],
    ["Backend", "Node/Express · port 4000", "Sign-up wizard, OTP, wallet login, mock KYC, income check, attestation signing, notifier and inbox, admin and demo endpoints."],
    ["Website", "React/Vite · port 5173", "Everything the user sees. Calls the backend through <font face='Consolas'>/api</font> and the contracts through the wallet."],
], [0.2, 0.27, 0.53])

P("3. Running it on your computer", "h2")
P("<b>Prerequisites:</b> Node.js 20 or newer, npm, Git, and optionally the MetaMask browser extension. Run all commands from the project folder <font face='Consolas'>blockchain project</font>.")
P("One-time install", "h3")
code([
    "npm install",
    "cd backend  && npm install && copy .env.example .env && cd ..",
    "cd frontend && npm install && cd ..",
])
P("Every time you start (four terminals, in this order)", "h3")
table([
    ["#", "Terminal", "Command", "Wait for"],
    ["1", "Blockchain", "<font face='Consolas'>npx hardhat node</font>", "\"Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545\""],
    ["2", "Deploy", "<font face='Consolas'>npm run deploy:local</font>", "\"Deployment complete.\" (this also writes the addresses into the website and backend)"],
    ["3", "Backend", "<font face='Consolas'>cd backend</font><br/><font face='Consolas'>npm run db:reset</font><br/><font face='Consolas'>npm run dev</font>", "\"listening on http://localhost:4000\". Keep this terminal visible: OTP codes are printed here."],
    ["4", "Website", "<font face='Consolas'>cd frontend</font><br/><font face='Consolas'>npm run dev</font>", "The local URL, then open <b>http://localhost:5173</b>"],
], [0.05, 0.14, 0.33, 0.48])
note("<b>Why db:reset?</b> The Hardhat node forgets everything when it stops. Resetting the backend database after a fresh chain removes old accounts that point at wallets the new chain does not know.")
P("Load the demo data (optional but recommended)", "h3")
P("With all four terminals running, open a fifth terminal:")
code([
    "cd backend && npm run seed:demo && cd ..",
    "npm run demo:scenarios",
])
P("<font face='Consolas'>seed:demo</font> signs up five accounts through the real sign-up flow. <font face='Consolas'>demo:scenarios</font> then lends 20 ETH and moves chain time forward about 130 days. It leaves one Hardship, one Strategic and one Fraud defaulter and a borrower in good standing.")

P("4. Wallets and demo accounts", "h2")
P("Every action that moves money is signed by a wallet. You can use either option below.")
bullets([
    "<b>Dev wallet (easiest, no extension):</b> add <font face='Consolas'>?devwallet=N</font> to any address, e.g. <font face='Consolas'>http://localhost:5173/login?devwallet=3</font>. The page then uses Hardhat test account N. It works only with the local development server. Use <font face='Consolas'>?devwallet=off</font> to switch it off.",
    "<b>MetaMask:</b> add a network with RPC <font face='Consolas'>http://127.0.0.1:8545</font>, chain ID <font face='Consolas'>31337</font>, currency ETH. Import the private key of the account you want from the table below. After restarting the node, use MetaMask → Settings → Advanced → <i>Clear activity tab data</i>.",
])
table([
    ["Account", "Demo login (password: demo-password-1)", "Role after demo:scenarios", "Private key (Hardhat test key)"],
    ["#0", "f39fd6@demo.giglend.test", "Ops Admin (admin + dispute roles), lender", "<font face='Consolas' size='7'>0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80</font>"],
    ["#3", "90f79b@demo.giglend.test", "Asha · Hardship defaulter on a workout plan", "<font face='Consolas' size='7'>0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6</font>"],
    ["#4", "15d34a@demo.giglend.test", "Vikram · Strategic defaulter", "<font face='Consolas' size='7'>0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a</font>"],
    ["#5", "996550@demo.giglend.test", "Ravi · Fraud, permanently barred", "<font face='Consolas' size='7'>0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba</font>"],
    ["#7", "14dc79@demo.giglend.test", "Meena · good borrower with an open loan", "<font face='Consolas' size='7'>0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356</font>"],
    ["#10–#19", "(sign up yourself)", "Fresh wallets for new test users", "Printed by <font face='Consolas'>npx hardhat node</font>"],
], [0.1, 0.27, 0.27, 0.36])

P("5. A tour of the website", "h2")

P("Home page", "h3")
P("The landing page explains GigLend. The top bar has <b>Log in</b>, <b>Sign up</b> and <b>Connect Wallet</b>. Lending is open to anyone with a wallet; borrowing needs a verified account.")
shot("01_landing", "Landing page with the new Log in / Sign up buttons.")

P("Signing up (five steps)", "h3")
P("The sign-up wizard saves each step, so you can log in later and continue where you stopped.")
numbered([
    "<b>Account:</b> name, email, mobile and password. A 6-digit code is printed in the <i>backend terminal</i> (look for <font face='Consolas'>[mock-otp] ... code=123456</font>). Enter it to verify.",
    "<b>Link wallet:</b> sign a message with your wallet (Sign-In with Ethereum). It costs nothing and sends no transaction.",
    "<b>Verify identity:</b> a PAN-format string (5 letters, 4 digits, 1 letter, e.g. <font face='Consolas'>ABCDE1234F</font>), the <i>last 4</i> digits of Aadhaar, and any selfie image. Only a salted hash of the PAN ever reaches the blockchain.",
    "<b>Gig and income:</b> platform, worker ID, how you are paid (weekly or every two weeks), 3–6 months of payouts in rupees, and every existing EMI.",
    "<b>Consent:</b> data use (required), autopay (on by default) and lending-circle visibility (optional). Then press <b>Register on-chain</b>.",
])
two_shots("02_signup", "Step 1 of the wizard with the progress bar.", "03_login", "Log in: password or one-time code, then a wallet signature.")

P("Logging in", "h3")
P("Enter your email or mobile and password (or ask for a one-time code), then press <b>Sign in with Ethereum</b>. The signature must come from the wallet linked to your account. If the browser wallet later switches to a different account, a red banner appears and every button is disabled until you switch back.")

P("Dashboard", "h3")
P("Shows wallet balance, GLP (pool shares), your current borrowing limit and why, any open loan with its stage, your credit score on the 300–900 scale and your tier (New → Builder → Standard → Trusted → Prime). The bell at the top right shows unread messages.")
shot("10_dashboard", "Meena's dashboard: score 597/900, Builder tier, an open loan in the Onset stage, one unread notice.")

P("Borrow", "h3")
P("Choose the loan type, amount and number of installments. The right side explains your limit line by line and shows a <b>key fact statement</b> (rate, installment, total cost, late fee, grace period, penalty-free exit) that is priced live. If a rule blocks the loan, the reason appears there before you submit.")
shot("30_borrow", "Borrow page for a new member: only the credit-builder loan is available until one is repaid.")
bullets([
    "<b>Credit-builder loan:</b> the money is held in escrow and paid to you only after the last installment. It builds your record at no risk to lenders.",
    "<b>Unsecured loan:</b> paid to your wallet now. It needs one completed builder loan, 90 days of pool stake, and stake covering 50% of the loan (yours, or pledged by a guarantor). The first one is capped at ₹1,000 (0.01 ETH).",
    "While any loan is open, your GLP stake is locked: you cannot withdraw or transfer it.",
])
two_shots("31_borrow_limits", "\"Your limit, and why\": each cap is listed separately.",
          "32_borrow_kfs", "Key fact statement, priced live from the contracts.")

P("Loans", "h3")
P("The stage timeline shows where your loan is. Help options (payment holiday, tenure stretch) are shown <i>before</i> the amount you owe. Below them: what you owe, pay buttons, the installment schedule, your SafeRepay vault, and loan history.")
shot("11_loans_top", "An overdue loan in the Onset stage, with restructure options shown first.")
shot("13_loans_schedule", "Installment schedule: paid, current (overdue · Onset) and upcoming installments.", width=CONTENT_W * 0.85)

P("Notifications", "h3")
P("Messages come from one named community contact, who stays the same on every loan. Each message offers help first, then states the amount and date, and names the grievance officer. Messages are only sent between 08:00 and 19:00 in the member's time zone; anything created outside those hours waits in a queue.")
shot("14_notifications", "An overdue notice from the member's contact, with the grievance line.")

P("After a default", "h3")
P("When a loan is marked as defaulted, the Loans page shows the classification and the reason rule, the appeal deadline, the remaining balance, a discounted <b>settle today</b> amount, and (for Hardship) a workout plan with small installments and no interest. Borrowing stays blocked until the balance is settled; the cooling-off period starts on the day you settle.")
shot("20_asha_loans", "Asha (Hardship): workout plan, remaining balance and the settlement quote.")
shot("21_asha_borrow_blocked", "Borrow page for a defaulter: \"Cooling-off active\", and re-entry must start with a builder loan.")

P("Lend", "h3")
P("Deposit ETH to receive GLP shares and withdraw them later. The page shows the live share price, how much of your GLP is locked as loan stake, and any withdrawal still waiting in the queue. If the pool's free cash is short, a withdrawal joins a first-in-first-out queue and is paid as loans repay.")
shot("16_lend", "Lend page: share price, reserve (a loss buffer, not a guarantee) and locked stake.")

P("Lend Pool (disclosures)", "h3")
P("The pool page shows the pool value (late loans count for less), free cash, outstanding loans, the reserve, loans grouped by stage, arrears reported twice (with and without restructured loans), losses by month, and your queue position. It states plainly that returns are never guaranteed.")
shot("40_pool", "Pool disclosures.")
two_shots("41_pool_npl", "Loans by stage and how much each counts for.", "42_transactions", "Transactions ledger: every contract event with filters.")

P("Admin console", "h3")
P("Only visible to the Ops Admin account. It holds the appeals queue (reclassify a default), systemic-shock mode for a cohort, wallet-cluster flags, the misdeclared-debt flag, cohort pause status, every policy parameter with its allowed range, and the message log.")
shot("50_admin", "Admin console: roles, appeals, shock mode and cluster flags.")
P("Demo panel", "h3")
P("Local-only tools for testing: send a mock gig payout to any wallet, move chain time forward by 1–90 days, run the notifier now, and run keeper actions (<font face='Consolas'>accrueLate</font>, <font face='Consolas'>collect</font>, <font face='Consolas'>markDefault</font>, <font face='Consolas'>autopay</font>) on any loan number.")
shot("51_demo", "Demo panel: mock payouts, time travel and keeper actions.")

P("6. How a loan's life works", "h2")
P("Stages are calculated from the due date of the unpaid installment. Nothing has to run in the background to move a loan between stages.")
table([
    ["Stage", "When (days after the due date)", "What happens", "Counts in pool value at"],
    ["Early warning / Reminder", "7 and 3 days <i>before</i> due", "Inbox nudge if payouts are falling or SafeRepay is too low to cover the installment.", "100%"],
    ["Grace", "Days 1–3 (7 for Trusted/Prime members or loans over 3 months)", "Autopay retries. No fee, no score penalty, no personal contact.", "100%"],
    ["Onset", "Days 4–10", "One flat late fee for this installment (never compounds). Score penalty. Notice sent. Payment holiday still allowed.", "90%"],
    ["Significant", "Days 11–29 (to 44 for long loans)", "Anyone can call collect(): locked stake pays the installment and the caller earns a small bounty. Guarantor alerted.", "50%"],
    ["Default", "Day 30 (45 for long loans)", "Anyone can call markDefault(): classification, then the loss waterfall, then a residual claim.", "0%"],
], [0.17, 0.23, 0.42, 0.18])
P("Loss waterfall at default: <b>1.</b> borrower's locked stake → <b>2.</b> guarantor's stake → <b>3.</b> reserve fund → <b>4.</b> lenders, through a lower share price. Whatever is still unpaid stays as a claim on the member. Half of any later deposit or payout goes to that claim automatically.")
table([
    ["Type", "Typical signals", "Settlement discount", "Cooling-off after settlement"],
    ["Hardship", "Seasoned member, income fell or asked for help", "25%, plus an interest-free workout plan", "30 days"],
    ["Strategic", "Payouts kept arriving after the miss, never asked for help", "5%", "12 months"],
    ["Fraud", "Two of: first-payment default, a new or thin stake, a flagged wallet cluster", "None", "Never (permanently barred)"],
], [0.14, 0.42, 0.22, 0.22])

P("7. Time-travel cheat sheet", "h2")
P("Use <b>Demo panel → +N days</b> (or <font face='Consolas'>node scripts/timeTravel.js advance N</font>). Time travel moves the whole chain, so every demo loan ages together. For a <b>new weekly loan with nothing paid</b>, the first installment is due 7 days after it opens:")
table([
    ["Move forward from the moment the loan opened", "Stage of the first installment"],
    ["+6 days", "Active (reminder window)"],
    ["+8 days", "Grace (no fee)"],
    ["+11 days", "Onset (late fee charged once)"],
    ["+18 days", "Significant (collect allowed)"],
    ["+37 days", "Default-eligible (markDefault allowed)"],
], [0.6, 0.4])
note("Other handy commands: <font face='Consolas'>node scripts/timeTravel.js status &lt;loanId&gt;</font> prints a loan's stage. <font face='Consolas'>node scripts/timeTravel.js 31</font> moves 31 days and defaults every eligible loan.")

# ─────────────────────────────────────────────────────────────────────────────
# PART 2 — tests
# ─────────────────────────────────────────────────────────────────────────────
story.append(PageBreak())
P("PART 2", "part")
P("Manual tests", "h1")
P("Eleven short tests that cover the main kinds of user: lenders, new members, normal borrowers, late payers, borrowers who ask for help, and each type of defaulter. Run them in order on a fresh start (section 3, including <font face='Consolas'>seed:demo</font> and <font face='Consolas'>demo:scenarios</font>). Tests that sign up new users use dev-wallet accounts #10–#19.")
note("<b>Before you begin:</b> keep the backend terminal visible (OTP codes). Time travel affects every loan on the chain, so finish one test's time jumps before starting the next. If a page shows stale numbers after a jump, press Refresh or reload.")

TESTS = [
    {
        "id": "T1", "title": "Lender: deposit, share price, withdrawal and locked stake",
        "who": "Any wallet for deposits (e.g. <font face='Consolas'>?devwallet=12</font>); Meena (#7) for the locked-stake check.",
        "proves": "Lending is open to everyone, shares are priced from pool value, and stake behind an open loan cannot leave.",
        "steps": [
            "Open <b>Lend</b>, deposit <b>1 ETH</b> and confirm.",
            "Check the GLP received is about 1 ÷ share price, and that <b>Lend Pool</b> shows pool value up by about 1 ETH.",
            "Switch to <b>Redeem / Withdraw</b>, withdraw 0.5 GLP.",
            "Log in as Meena (open loan) and try to withdraw all her GLP.",
        ],
        "expect": "Deposit and withdrawal succeed and appear in Transactions as Deposited / Withdrawn. Meena's withdrawal is refused: \"Part of your GLP is locked as stake for an open loan or guarantee.\" Her Lend page shows the locked amount.",
    },
    {
        "id": "T2", "title": "New member sign-up and on-chain registration",
        "who": "A new user with <font face='Consolas'>http://localhost:5173/signup?devwallet=10</font>.",
        "proves": "The five-step wizard works, bad input is refused, and the member is registered on-chain.",
        "steps": [
            "Create the account. Enter a <i>wrong</i> code first, then the real code from the backend terminal.",
            "Press <b>Connect</b>, then <b>Sign and link wallet</b>.",
            "In <b>Verify identity</b>, try a 12-digit Aadhaar number first, then use only 4 digits, a new PAN (e.g. <font face='Consolas'>TESTA1234Z</font>) and any image.",
            "Fill in income (3 months, weekly) with one EMI. On the consent step, try to continue without data-use consent, then tick it.",
            "Press <b>Register on-chain</b>, then open <b>Profile</b>.",
        ],
        "expect": "Wrong code is rejected (\"That code is not correct\"). A full Aadhaar is rejected. Consent cannot be skipped. Profile shows: contact verified, linked wallet, masked PAN, on-chain member number, tier <i>New</i>, score 550, a named community contact, and the income band. Transactions shows MemberRegistered.",
    },
    {
        "id": "T3", "title": "Login security: password + wallet, wrong wallet, wallet switch",
        "who": "The member from T2.",
        "proves": "A session is valid only when the signing wallet is the linked wallet.",
        "steps": [
            "Log out (profile menu → Log out). Open <font face='Consolas'>/login?devwallet=11</font>, enter the T2 email and password, press <b>Sign in with Ethereum</b>.",
            "Open <font face='Consolas'>/login?devwallet=10</font> and log in again with the correct wallet.",
            "Try the <b>One-time code</b> tab: request a code, enter it from the backend terminal.",
            "(MetaMask only) After logging in, switch MetaMask to another account.",
        ],
        "expect": "With wallet #11 the login is refused (wrong wallet). With #10 you reach the Dashboard. The one-time code works the same as the password. With MetaMask switched, a red banner appears and buttons are disabled.",
    },
    {
        "id": "T4", "title": "Normal borrower: credit-builder loan from start to finish",
        "who": "The member from T2 (logged in with devwallet 10).",
        "proves": "Credit-builder first; money stays in escrow until fully repaid; good repayment raises the score.",
        "steps": [
            "Open <b>Lend</b> and deposit <b>0.02 ETH</b> as stake (needed later for T5).",
            "Open <b>Borrow</b>. Check the Unsecured option shows \"Complete a Builder loan first\". Read the key fact statement.",
            "Open a <b>credit-builder</b> loan of 0.01 ETH with 2 installments (untick autopay to keep it simple).",
            "On <b>Loans</b>, check \"Held in escrow for you\" = 0.01 ETH and your wallet did not receive it. Press <b>Pay</b> for each installment.",
        ],
        "expect": "After the last payment: \"Loan fully repaid\", the 0.01 ETH escrow arrives in your wallet, Loan history shows <i>Repaid 2/2</i>, the score rises (550 → 573) and the tier becomes <i>Builder</i>. While the loan was open, Borrow showed \"You have an open loan\" instead of a new application.",
    },
    {
        "id": "T5", "title": "Normal borrower: first unsecured loan and the limits",
        "who": "The same member after T4.",
        "proves": "Unsecured loans need 90 days of stake, 50% cover and the ₹1,000 first cap; limits explain themselves.",
        "steps": [
            "On <b>Borrow</b>, note the hold message \"Stake must be held for 90 days\".",
            "<b>Demo panel → +90 days.</b> (Your stake has to be deposited <i>before</i> this jump; T4 step 1 did that.)",
            "Back on <b>Borrow</b>, choose Unsecured and enter 0.02 ETH. Read the red message in the key fact statement. Change it to 0.01 ETH, keep autopay on and open the loan.",
            "Open <b>Lend</b> and look at locked GLP.",
        ],
        "expect": "0.02 ETH is refused with \"Above ladder limit\". 0.01 ETH (₹1,000) is paid straight to your wallet. All your GLP shows as locked. The limit panel shows the 35% income cap and the other caps with their remaining room.",
    },
    {
        "id": "T6", "title": "Late payer: grace, one late fee, then collect from stake",
        "who": "The member from T5 with the open unsecured loan (note its loan number on Loans).",
        "proves": "No fee during grace; one non-compounding fee in Onset; stake is applied only from Significant, with a keeper bounty.",
        "steps": [
            "Demo panel <b>+8 days</b>: Loans shows <i>Grace</i>; \"Due now\" equals the installment (no fee).",
            "<b>+3 days</b> (Onset): \"Due now\" grows by one small late fee. Demo panel → <b>Accrue late status</b>. Transactions shows InstallmentMissed and LateFeeCharged once.",
            "<b>+4 days</b>: the fee is unchanged. Try Demo panel → <b>collect()</b>: it fails.",
            "<b>+4 days</b> (Significant): press <b>collect()</b> again.",
        ],
        "expect": "Grace has no fee and no score penalty. The fee is charged once and never grows. collect() fails with \"Not in Significant stage\" before day 11, then succeeds: Transactions shows StakeApplied and BountyPaid, and installment 1 is marked paid from the locked stake.",
    },
    {
        "id": "T7", "title": "Borrower who asks for help: payment holiday and its limits",
        "who": "The member from T5/T6. After T6 their second installment is a few days overdue (Onset).",
        "proves": "One priced restructure per loan, allowed before due or in Onset, never twice.",
        "steps": [
            "On <b>Loans</b>, note the stage (<i>Onset</i>) and the next due date. Press <b>Request holiday</b>.",
            "Check the next due date moved one cycle later, the stage is back to on-time, and a small holiday fee was added to \"Due now\".",
            "Press <b>Request holiday</b> again.",
            "Open <b>Lend Pool</b> and read the restructured-loans and arrears figures.",
        ],
        "expect": "The first request succeeds (RestructureGranted in Transactions). The second fails with \"Loan already restructured\". The pool page shows <i>Restructured loans: 1</i>, and arrears are reported both with and without restructured loans.",
    },
    {
        "id": "T8", "title": "Defaulters (Hardship): default timing, stake recovery, workout, settlement",
        "who": "The member from T7, Meena (#7, loan #7) and Asha (#3).",
        "proves": "Default only from day 30; locked stake is used first; hardship gets a workout and a 25% discount; cooling-off starts at settlement; re-entry starts with a builder loan.",
        "steps": [
            "Demo panel → <b>markDefault()</b> on the T7 member's loan (now on time after the holiday).",
            "Meena's loan #7 is now long overdue after the earlier time jumps. Run <b>markDefault()</b> on loan 7, then log in as Meena and open <b>Loans</b>.",
            "Log in as Asha. On <b>Loans</b>, read the classification, remaining balance and \"Settle today\" amount (about 75%). Pay one workout installment, then press <b>Settle</b>.",
            "Open <b>Borrow</b> as Asha. Then Demo panel <b>+31 days</b> and open Borrow again.",
        ],
        "expect": "Step 1 fails with \"Default day not reached\". Meena's default succeeds as <i>Hardship</i>: her locked stake covered the whole debt (lender loss 0 in Transactions), so there is no balance and Loans shows a 30-day cooling-off date. For Asha, Borrow shows \"Cooling-off active\" after settling. 31 days later it opens again, but Unsecured says \"Re-entry after default starts with a Builder loan\".",
    },
    {
        "id": "T9", "title": "Defaulters (Strategic and Fraud) and the appeal",
        "who": "Vikram (#4) to observe Strategic; a new user with <font face='Consolas'>?devwallet=14</font> for Fraud; Ops Admin (#0).",
        "proves": "Classification follows the public rule, fraud is barred and its wallet cluster flagged, and an appeal lets the admin reclassify.",
        "steps": [
            "As Vikram, open <b>Loans</b>: the type is <i>Strategic</i> (payouts kept arriving after the miss) and \"Settle today\" is about 95% of the balance.",
            "Sign up a new user with devwallet 14. Do <b>not</b> deposit anything. Open a credit-builder loan of 0.02 ETH and never pay. Demo panel <b>+37 days</b>, then <b>markDefault()</b> on that loan.",
            "As the new user, open <b>Borrow</b> (blocked) and <b>Loans</b>, and press <b>Appeal</b>.",
            "As Ops Admin, open <b>Admin</b>: see the flagged cluster, then press <b>→ Hardship</b> on the appeal. Reload the new user's Borrow and Loans pages.",
        ],
        "expect": "Vikram: Strategic, 5% discount, 12 months of cooling-off after settlement. New user: classified <i>Fraud</i> (first-payment default and no stake). Borrow says \"Permanently barred\" and Admin lists the cluster as flagged. After reclassification, Transactions shows Reclassified (Fraud → Hardship); the user is no longer barred (Borrow now says \"Cooling-off active\" until the small balance is settled) and the workout option appears.",
    },
    {
        "id": "T10", "title": "Same person, new wallet: the default follows the identity",
        "who": "Vikram (#4, unsettled Strategic default) and a new sign-up with <font face='Consolas'>?devwallet=13</font>.",
        "proves": "One real person = one record; a fresh wallet cannot escape an old default.",
        "steps": [
            "Sign up a new account with devwallet 13. At the identity step use Vikram's PAN <font face='Consolas'>VIKRM5678B</font>.",
            "Log in as Vikram and press <b>Profile → Unlink this wallet</b> (allowed because he has no open loan).",
            "Log back in as the new account (it resumes at the identity step), enter <font face='Consolas'>VIKRM5678B</font> again, finish the wizard and register on-chain.",
            "Open <b>Profile</b>, <b>Loans</b> and <b>Borrow</b> with the new wallet.",
        ],
        "expect": "Step 1 is refused: \"This identity already has an active wallet...\". After unlinking, the new wallet joins Vikram's record (\"This identity already has a GigLend record...\"). Profile shows Vikram's member number. Loans shows his Strategic default and balance, and Borrow says \"Cooling-off active\".",
    },
    {
        "id": "T11", "title": "Admin and safety: shock mode, parameters, notices and disclosures",
        "who": "Ops Admin (#0) plus the T5 member (the only open loan left).",
        "proves": "Shock mode protects a whole cohort without waiving principal; parameters are bounded; contact rules and disclosures hold.",
        "steps": [
            "In <b>Admin → Cohorts</b>, note the borrower's cohort. Set <b>shock mode</b> for it: 14 days, event \"Platform outage test\".",
            "Using the T5 member's open loan (same cohort), press Demo panel +1 day until Loans shows the installment is about 6 days late. Check Loans and Pool.",
            "In <b>Policy parameters</b>, set <font face='Consolas'>burdenBps</font> to 6000 and save; then set it to 4000.",
            "Open the bell / <b>Notifications</b> and <b>Admin → Message log</b>. Then read the <b>Lend Pool</b> page.",
        ],
        "expect": "Under shock mode the loan is still in Grace at day 6 with no late fee, and outstanding principal is unchanged. 6000 is refused (\"Value out of bounds\"), 4000 is saved (ParameterUpdated). Every notice is signed by the named contact and carries the grievance line. Notices created outside 08:00–19:00 show as \"queued until 8:00\". The pool page shows loans by stage, both arrears figures, losses by month, and \"not a guarantee\". After T9's fraud default, the Cohorts table shows the cohort as <i>Paused (automatic)</i> for new first loans.",
    },
]


def test_block(t):
    head = Table([[Paragraph(f"<b>{t['id']}</b>", ParagraphStyle("tid", parent=S["cellb"], textColor=colors.white, fontSize=10.5)),
                   Paragraph(f"<b>{t['title']}</b>", ParagraphStyle("tt", parent=S["cellb"], fontSize=10.5))]],
                 colWidths=[0.09 * CONTENT_W, 0.91 * CONTENT_W])
    head.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), GOLD), ("BACKGROUND", (1, 0), (1, 0), GOLD_LIGHT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
    ]))
    steps = "<br/>".join(f"{i}. {s}" for i, s in enumerate(t["steps"], 1))
    rows = [
        [Paragraph("Proves", S["cellb"]), Paragraph(t["proves"], S["cell"])],
        [Paragraph("Log in as", S["cellb"]), Paragraph(t["who"], S["cell"])],
        [Paragraph("How to test", S["cellb"]), Paragraph(steps, S["cell"])],
        [Paragraph("Expected", S["cellb"]), Paragraph(t["expect"], S["cell"])],
        [Paragraph("Result", S["cellb"]), Paragraph("[&nbsp;&nbsp;] Pass &nbsp;&nbsp;&nbsp; [&nbsp;&nbsp;] Fail &nbsp;&nbsp;&nbsp; Notes: ______________________________________________", S["cell"])],
    ]
    body = Table(rows, colWidths=[0.16 * CONTENT_W, 0.84 * CONTENT_W])
    body.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 3), (-1, 3), GREEN_BG),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
    ]))
    return KeepTogether([head, body, Spacer(1, 12)])


P("Test summary", "h2")
table([["#", "Test", "User type"]] + [
    [t["id"], t["title"], ut] for t, ut in zip(TESTS, [
        "Lender", "New member", "Any member", "Normal borrower", "Normal borrower", "Late payer",
        "Borrower asking for help", "Defaulter (Hardship)", "Defaulters (Strategic, Fraud) + admin",
        "Defaulter with a new wallet", "Admin / everyone",
    ])
], [0.07, 0.65, 0.28])
story.append(PageBreak())

for t in TESTS:
    story.append(test_block(t))

P("Sign-off", "h2")
table([["Tester", "Date", "Build / commit", "Tests passed", "Notes"], ["", "", "", "&nbsp;&nbsp;&nbsp;/ 11", ""]], [0.2, 0.14, 0.22, 0.14, 0.3])
P("Troubleshooting", "h2")
table([
    ["Symptom", "Fix"],
    ["\"Connect Your Wallet\" on every page", "Add <font face='Consolas'>?devwallet=N</font> to the address, or unlock MetaMask on network 31337."],
    ["Login says the wallet is wrong", "The browser wallet is not the one linked to that account. Use the account number from the table in section 4."],
    ["\"Registry unavailable\" or zero balances", "The node was restarted. Run <font face='Consolas'>npm run deploy:local</font>, then <font face='Consolas'>npm run db:reset</font> and restart the backend."],
    ["\"Attestation expired\" after big time jumps", "Profile → Refresh attestation (it signs a new one valid for 365 chain days)."],
    ["MetaMask \"nonce too high\"", "MetaMask → Settings → Advanced → Clear activity tab data."],
    ["No notices in the inbox", "Outside 08:00–19:00 they wait in the queue; check Admin → Message log, or press \"Run the notifier now\" on the Demo panel."],
    ["Too many requests (rate limited)", "Wait one minute; sign-up and login allow 60 requests per minute."],
], [0.38, 0.62])

doc.build(story)
print("wrote", os.path.abspath(OUT))
