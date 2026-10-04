import json, html
S = __import__('os').path.dirname(__import__('os').path.abspath(__file__))
d = json.load(open(f"{S}/demo.json"))
BOT = "Sidebet"
scenes = [
  {"id": "open", "label": "Open a market", "note": "Marcus opens a market. Sidebet reads months of the chat and sets the odds, with receipts.", "msgs": [
    {"from": "Marcus", "text": "!new will sam climb a v5 b4 graduating?"},
    {"from": BOT, "text": "⏳ Setting odds for #71…"},
    {"from": BOT, "text": d["new71"], "card": True},
  ]},
  {"id": "bets", "label": "Bets", "note": "Every bet updates the odds, the payouts and the chart. Sidebet tags the notable ones.", "msgs": [
    {"from": "Marcus", "text": "!no 71 50"},
    {"from": BOT, "text": d["bet71a"], "card": True},
    {"from": "Sam", "text": "!yes 71 120"},
    {"from": BOT, "text": d["bet71b"], "card": True},
    {"from": "Theo", "text": "!no 71 40"},
    {"from": BOT, "text": d["bet71c"], "card": True},
    {"from": BOT, "img": "chart-71.png", "alt": "Chart for market 71: 68% chance, Sam 120 on YES, Marcus 50 and Theo 40 on NO"},
  ]},
  {"id": "watch", "label": "It's watching", "note": "Between commands, Sidebet reads the chat. Real evidence gets a reaction; a bold claim gets a market offer.", "msgs": [
    {"from": "Marcus", "text": "just hit 315 on squat at hadley 😤 video in a sec"},
    {"from": BOT, "text": "👀 #72 · Theo's 50 coins looking smart, Vish's 80 about to get squatted on. Video pending though."},
    {"from": "Marcus", "text": "sam is 100% gonna be late to the game saturday"},
    {"from": BOT, "text": "👀 Sounds like a bet\n━━━━━━━━━━━━━━\n𝗪𝗶𝗹𝗹 𝗦𝗮𝗺 𝘀𝗵𝗼𝘄 𝘂𝗽 𝗹𝗮𝘁𝗲 𝘁𝗼 𝘁𝗵𝗲 𝗴𝗮𝗺𝗲 𝗼𝗻 𝗦𝗮𝘁𝘂𝗿𝗱𝗮𝘆?\n\nReply !new to open it.", "card": True},
  ]},
  {"id": "settle", "label": "Settle up", "note": "Leo bet on his own aura, then resolved his own market. Results and who-paid-who post automatically.", "msgs": [
    {"from": "Leo", "text": "!new does Leo have the most aura out of the friend group?"},
    {"from": BOT, "text": d["new64"], "card": True},
    {"from": "Leo", "text": "!yes 64 50"},
    {"from": BOT, "text": d["bet64a"], "card": True},
    {"from": "Vish", "text": "!no 64 50"},
    {"from": BOT, "text": d["bet64b"], "card": True},
    {"from": "Leo", "text": "!resolve 64 yes"},
    {"from": BOT, "text": d["resolved64"], "card": True},
    {"from": BOT, "img": "chart-64.png", "alt": "Chart for market 64, resolved Yes: Leo 50 on YES, Vish 50 on NO"},
  ]},
]
data = json.dumps(scenes, ensure_ascii=False).replace("</", "<\\/")
page = open(f"{S}/template.html").read().replace("__SCENES__", data)
open(f"{S}/index.html", "w").write(page)
print("built", len(page))

# Inline every image as a data URI: files published beside the page don't load in the viewer.
import base64
page = open(f"{S}/index.html").read()
for name in ["logo.png", "chart-71.png", "chart-64.png"]:
    uri = "data:image/png;base64," + base64.b64encode(open(f"{S}/{name}", "rb").read()).decode()
    page = page.replace(f'"{name}"', f'"{uri}"')
open(f"{S}/index.html", "w").write(page)
print("inlined", len(page))
