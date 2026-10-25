"""The Store Bot: a small, self-contained in-app assistant.

No external LLM and no subscription — it answers from THIS app's own data and
screens, instantly (the stock list is the cached one every screen reads). The
store chose this over connecting an AI model, so every question stays on the
plant's machine, and asked that the data come back however it is asked ("store
bot aise design ho ki data kisi bhi tarike se pucha jaaye answer turant mile" —
18 Oct 2026, after "top 10 excess part max value" got no figures).

A question is first put into one spelling: Hindi in Devanagari read as the
Hinglish words it is (_DEVANAGARI), shop-floor shortforms spelt out ("stck",
"mngwana", "krna", "khtm" — _SYNONYMS), and a word one or two letters off a
word the bot knows corrected to it ("exces", "critcal", "mantenance", "sensr" —
_correct). Then it is read in pieces, and answered in the language it was asked
in ("hindiglish ya jis bhasha me"):
  * a part number in it, however typed (CNTR3200, cntr-3200, "CNTR 3200", an
    old / new number, two of them) — those parts first;
  * WHICH parts: a bucket (critical / short, out of stock, running low, below
    min, reorder, excess, healthy, never counted, no rate, no min / max, no
    location — or NOT one of them: "jo khatam nahi hai"), sections (Maintenance,
    Press / General Tool Room, "Tool Room" = both), a part type and its family
    ("valve" = every … Valve type), a rack / shelf / bin however written (R4,
    "rack 4", R4 B33, R4-S6-B33(1), r4s6b33, "pipe rack"), a figure past a line
    ("rate 500 se upar", "1 lakh se upar ka excess", "stock 5 se kam"), a level
    ("min 10 wale");
  * BY WHAT: excess value / qty (the Live Board's own figure: above max x
    rate), stock value, rate (mehenga / sasta), stock qty, order value / qty
    (up to max), consumption (qty or value used in a period: aaj, is mahine,
    pichhle mahine, september, 2026, 90 din …);
  * HOW MANY: "top 10", "5 part", "sabse …" (largest first; "sabse kam",
    "cheapest", "lowest" turn it round), or "kitne" / "total" for a count and a
    sum; "section wise", "kis section me", "maintenance vs tool room" for one
    line per section;
  * otherwise the words left once the filler is dropped ("dikhao", "kitna",
    "the", "show me" …), matched against part number, name, spec and bins;
    a "kaise / how to" question gets the screen that does it.
Each answer is a sentence with the count and the money, and the parts as cards
(ranked, the figure asked for on each), each opening the part.

Suggestions and the screen catalogue respect the caller's rights: a screen the
user may not open (per-module or admin-only) is never suggested or listed, so a
link never lands on an "access restricted" dead-end.
"""
import re
from collections import namedtuple
from datetime import date, timedelta
from urllib.parse import quote

from app.services.service_catalog import SERVICES
from app.services.spare_stock_service import SpareStockService

STORE = "MAINTENANCE"

# ---- one spelling -------------------------------------------------------------

# Hindi typed in Devanagari, word by word, into the Hinglish the rest reads.
_DEVANAGARI = {
    "स्टॉक": "stock", "स्टाक": "stock", "कितना": "kitna", "कितने": "kitne", "कितनी": "kitni", "है": "hai",
    "हैं": "hain", "एक्सेस": "excess", "पार्ट": "part", "पार्ट्स": "parts", "दिखाओ": "dikhao", "दिखा": "dikha",
    "बताओ": "batao", "क्या": "kya", "खत्म": "khatam", "ख़त्म": "khatam", "टॉप": "top", "वैल्यू": "value",
    "मूल्य": "value", "सेंसर": "sensor", "मेंटेनेंस": "maintenance", "मेंटेनेन्स": "maintenance", "में": "me",
    "मे": "me", "रीऑर्डर": "reorder", "ऑर्डर": "order", "का": "ka", "की": "ki", "के": "ke", "सबसे": "sabse",
    "ज़्यादा": "zyada", "ज्यादा": "jyada", "कम": "kam", "महंगा": "mehenga", "महँगा": "mehenga", "महंगे": "mehenge",
    "सस्ता": "sasta", "सस्ते": "saste", "रेट": "rate", "कीमत": "keemat", "दाम": "daam", "मंगाना": "mangana",
    "मंगवाना": "mangwana", "आज": "aaj", "कल": "kal", "महीने": "mahine", "महीना": "mahina", "इस": "is",
    "पिछले": "pichhle", "साल": "saal", "दिन": "din", "लिस्ट": "list", "सूची": "list", "बेयरिंग": "bearing",
    "सिलेंडर": "cylinder", "वाल्व": "valve", "कुल": "kul", "टोटल": "total", "नहीं": "nahi", "बिना": "bina",
    "लोकेशन": "location", "रैक": "rack", "टूल": "tool", "रूम": "room", "प्रेस": "press", "जनरल": "general",
    "क्रिटिकल": "critical", "मैक्स": "max", "मिन": "min", "से": "se", "ऊपर": "upar", "नीचे": "niche",
    "वाले": "wale", "वाला": "wala", "वाली": "wali", "धन्यवाद": "dhanyavad", "शुक्रिया": "shukriya",
    "नमस्ते": "namaste", "हेलो": "hello", "खपत": "khapat", "इस्तेमाल": "use", "उपयोग": "use", "इश्यू": "issue",
    "इशू": "issue", "हुआ": "hua", "हुए": "hue", "माल": "maal", "पड़ा": "pada", "पडा": "pada", "ज़रूरी": "zaroori",
    "जरूरी": "zaroori", "शॉर्ट": "short", "एक्स्ट्रा": "extra", "फालतू": "faltu", "गिना": "gina", "गिने": "gine",
    "काउंट": "count", "हिसाब": "hisaab", "सेक्शन": "section", "और": "aur", "या": "ya", "कौन": "kaun",
    "कौनसा": "konsa", "कहाँ": "kahan", "कहां": "kahan", "रखा": "rakha", "बचा": "bacha", "बचे": "bache",
    "चाहिए": "chahiye", "लाख": "lakh", "करोड़": "crore", "रुपये": "rupaye", "पैसा": "paisa", "पैसे": "paise",
    "दो": "do", "तीन": "teen", "चार": "char", "पांच": "paanch", "पाँच": "paanch", "दस": "das", "बीस": "bees",
    "कैसे": "kaise", "करें": "kare", "करे": "kare", "करना": "karna",
}
_DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
# Shop-floor shortforms and common misspellings, spelt out.
_SYNONYMS = {
    "stck": "stock", "stk": "stock", "stok": "stock", "stoc": "stock", "qnty": "qty", "qnt": "qty",
    "qtty": "qty", "val": "value", "vlu": "value", "valu": "value", "valeu": "value", "vaule": "value",
    "mngwana": "mangwana", "mangwna": "mangwana", "mgwana": "mangwana", "mngana": "mangana", "mangna": "mangana",
    "mngwane": "mangwane", "krna": "karna", "krne": "karne", "kru": "karu", "kro": "karo", "kre": "kare",
    "h": "hai", "hh": "hai", "hy": "hai", "hn": "hain", "xcess": "excess", "excs": "excess", "exces": "excess",
    "exess": "excess", "excees": "excess", "excesss": "excess", "exses": "excess", "critcal": "critical",
    "critial": "critical", "crtical": "critical", "mantenance": "maintenance", "maintanance": "maintenance",
    "maintainance": "maintenance", "maintenence": "maintenance", "maintance": "maintenance",
    "expencive": "expensive", "expensiv": "expensive", "consuption": "consumption", "consumtion": "consumption",
    "comsumption": "consumption", "cunsumption": "consumption", "reordr": "reorder", "rorder": "reorder",
    "reoder": "reorder", "locaton": "location", "loction": "location", "mahnga": "mehenga", "sabsey": "sabse",
    "sbse": "sabse", "jyda": "jyada", "zyda": "zyada", "ktna": "kitna", "ktne": "kitne", "dikao": "dikhao",
    "btao": "batao", "bta": "bata", "khtm": "khatam", "khatm": "khatam", "khtam": "khatam", "prts": "parts",
    "prt": "part", "kitn": "kitna",
}

_GREETINGS = {"hi", "hii", "hello", "hey", "namaste", "namaskar", "hlo", "helo"}
_THANKS = {"thanks", "thank", "thankyou", "thx", "dhanyavad", "dhanyawad", "shukriya"}
_ACKS = {"ok", "okay", "okk", "okey", "hmm", "hm", "acha", "achha", "accha", "theek", "thik", "thek", "fine", "cool",
         "done", "great", "nice", "badhiya"}
# What may stand beside a greeting / thanks / ok and still be only that.
_POLITE = {"bhai", "bhaiya", "ji", "sir", "you", "so", "much", "very", "bahut", "it", "got", "gaya", "hai", "ho",
           "kaise", "aap", "yaar", "dost", "bot", "store", "a", "lot"}

# Words that say a question is Hinglish — then the answer is Hinglish too.
_HINGLISH = {
    "hai", "hain", "ha", "ka", "ki", "ke", "ko", "kitna", "kitne", "kitni", "kya", "kyu", "kahan", "kaha",
    "kidhar", "batao", "bata", "dikhao", "dikha", "bhai", "bhaiya", "yaar", "khatam", "mangwana", "mangana",
    "zyada", "jyada", "jada", "kam", "bacha", "bache", "bachi", "nahi", "nhi", "kaun", "kon", "konsa", "kaunsa",
    "konse", "kaunse", "wala", "wale", "wali", "chahiye", "chaiye", "aaj", "abhi", "mera", "mere", "hamara",
    "paisa", "paise", "gina", "gine", "rakha", "rakhi", "pada", "padi", "sabse", "mein", "se", "namaste",
    "namaskar", "dhanyavad", "dhanyawad", "shukriya", "mehenga", "mehnga", "sasta", "mahine", "mahina", "din",
    "saal", "hisaab", "pichhle", "pichle", "isme", "usme", "lagaya", "nikla", "kaise", "kare", "karo", "karna",
    "karu", "hua", "hue", "huye", "gaya", "gaye", "tha", "thi", "raha", "rahe", "rha", "diya", "diye", "liya",
    "fasa", "phasa", "kis", "kisme", "padega", "jo", "jinka", "aur", "upar", "niche", "acha", "achha", "theek",
}
# Filler dropped before a sentence is matched against part names: the Hinglish
# above, and the English that only frames a question.
_FILLER = _HINGLISH | {
    "the", "a", "an", "is", "are", "was", "of", "for", "in", "on", "at", "to", "how", "many", "much", "what",
    "where", "which", "who", "show", "me", "give", "tell", "please", "pls", "plz", "stock", "qty", "quantity",
    "part", "parts", "item", "items", "no", "number", "location", "loc", "left", "available", "have", "we", "do",
    "does", "there", "current", "balance", "find", "search", "about", "info", "detail", "details", "status",
    "rate", "price", "and", "or", "all", "any", "bin", "rack", "shelf", "par", "pe", "list", "wise", "by", "with",
    "ab", "ya", "it", "its", "i", "my", "our", "can", "you", "get", "got", "need", "want", "want", "chahiye",
    "maal", "kya", "s", "lo", "do", "dena", "dedo", "de", "bhejo", "hamare", "humare", "store", "section",
}

# WHICH parts — the first bucket whose phrase is in the question, in this order
# (the specific "no rate" before "rate", "khatam hone wale" before "khatam" …).
Bucket = namedtuple("Bucket", "key en hi test")
_BUCKETS = [
    (Bucket("no_rate", "No rate", "Bina rate", lambda r: not r.get("unit_price")),
     ("no rate", "rate nahi", "rate nhi", "without rate", "rate missing", "unrated", "bina rate", "price nahi",
      "price nhi", "rate blank", "rate not", "zero rate", "rate 0", "rate zero", "0 rate", "rate nil", "no price",
      "bina price", "price 0")),
    (Bucket("no_minmax", "No min / max", "Bina min / max",
            lambda r: not r.get("min_stock_level") or r.get("max_stock_level") is None),
     ("no min", "no max", "min max nahi", "min max nhi", "min/max nahi", "without min", "without max",
      "min max missing", "min nahi", "max nahi", "min nhi", "max nhi", "bina min", "bina max")),
    (Bucket("no_location", "No location", "Bina location", lambda r: not (r.get("location") or "").strip()),
     ("no location", "location nahi", "location nhi", "without location", "bina location", "location missing",
      "location blank")),
    (Bucket("low", "Running low (not yet zero)", "Khatam hone wale (abhi zero nahi)",
            lambda r: r.get("status") in ("Below Minimum", "Reorder")),
     ("khatam hone", "khatam ho rahe", "khatam ho raha", "khatam hone ko", "running out", "about to finish",
      "about to run out", "running low", "near zero", "zero hone wale")),
    (Bucket("critical", "Critical (zero or below min)", "Critical (zero ya min se kam)",
            lambda r: r.get("status") in ("Out of Stock", "Below Minimum")),
     ("critical", "urgent", "zaruri", "zaroori", "jaruri", "kya kam", "kam hai", "kam hain", "kam pada",
      "kam ho gaya", "kam ho gaye", "kam wale", "kam wala", "shortage list")),
    (Bucket("out", "Out of stock", "Stock khatam", lambda r: r.get("status") == "Out of Stock"),
     ("out of stock", "zero stock", "no stock", "stock out", "khatam", "nil stock", "stock nahi", "stock nhi",
      "stock zero", "stock khali", "khali", "0 stock", "stock 0", "nahi bacha", "nhi bacha", "finished",
      "shunya")),
    (Bucket("below_min", "Below minimum", "Minimum se kam", lambda r: r.get("status") == "Below Minimum"),
     ("below min", "below minimum", "under min", "minimum se kam", "min se kam", "min se niche",
      "minimum se niche", "low stock", "kam stock", "stock kam", "short stock", "less than min")),
    (Bucket("reorder", "To reorder (at or below min)", "Reorder karne wale (min ya usse kam)",
            lambda r: r.get("status") in ("Out of Stock", "Below Minimum", "Reorder")),
     ("reorder", "re-order", "to order", "order karna", "order karne", "order karu", "order karo", "order kare",
      "kya order", "mangwana", "mangwane", "mangana", "mangane", "needs order", "purchase", "indent",
      "order list", "po raise", "po banana", "po bana", "po banani", "po banane", "order dena")),
    (Bucket("excess", "Excess (above max)", "Excess (max se zyada)", lambda r: r.get("status") == "Above Maximum"),
     ("excess", "above max", "above maximum", "over max", "overstock", "over stock", "extra stock", "surplus",
      "max se zyada", "max se jyada", "max se upar", "faltu", "zyada stock", "jyada stock", "jada stock",
      "zyada pada", "jyada pada", "extra pada", "faltu pada", "zyada maal", "jyada maal", "jada maal",
      "extra maal")),
    # Not required any more (22 Oct 2026): kept with its stock, never ordered.
    (Bucket("discontinued", "Discontinued (not required any more)", "Discontinued (ab zarurat nahi)",
            lambda r: bool(r.get("discontinued"))),
     ("discontinued", "discontinue", "obsolete", "not required", "no longer required", "zarurat nahi",
      "jarurat nahi", "jaroorat nahi", "zaroorat nahi", "required nahi")),
    (Bucket("healthy", "Healthy stock", "Theek stock", lambda r: r.get("status") == "Healthy"),
     ("healthy", "ok stock", "stock theek", "normal stock", "theek stock")),
    (Bucket("not_counted", "Never counted", "Abhi tak nahi gine", lambda r: r.get("qty_on_hand") is None),
     ("never counted", "not counted", "uncounted", "count nahi", "count nhi", "gina nahi", "gina nhi", "no count",
      "bina gine", "gine nahi", "gine nhi", "nahi gine", "nhi gine", "not count")),
]
_BUCKET = {b.key: b for b, _ in _BUCKETS}
_NEGATION = {"nahi", "nhi", "not", "na", "non"}
# "sabse zyada / kam stock", "max / min stock" are rankings, never buckets.
_RANKED_STOCK = re.compile(r"\b(?:sabse (?:zyada|jyada|jada|kam)|max(?:imum)?|min(?:imum)?|highest|lowest|most"
                           r"|least) (?:stock|qty|maal)\b")
_ASC_STOCK = re.compile(r"\b(?:sabse kam|min(?:imum)?|lowest|least) (?:stock|qty|maal)\b")
# "kitne" / "kitni" is a count ("kitne part", "kitne excess hain"), except
# "kitne ka / ki / ke" / "kitne rupaye" — a value.
_COUNT_WORD = re.compile(r"\bkit(ne|ni)\b(?!\s+(ka|ki|ke|ko|rupaye|rupees|rs|paise|paisa|value)\b)")

_VALUE = ("value", "worth", "rs", "rupees", "rupaye", "rupee", "rupay", "paisa", "paise", "amount", "money",
          "lakh", "crore", "kitne ka", "kitne ki", "kitne ke", "kimat ka")
_RATE = ("rate", "price", "mehenga", "mehnga", "mahenga", "mehenge", "mehengi", "mahenge", "mehange", "mehnge",
         "mehngi", "costly", "costliest", "expensive", "cost", "sasta", "saste", "sasti", "cheap", "cheapest",
         "daam", "keemat", "kimat", "unit price")
_QTY = ("qty", "quantity", "pieces", "pcs", "nos", "maal", "stock")
_ORDER_VALUE = ("order value", "reorder value", "kitne ka order", "order kitne ka", "po value", "purchase value",
                "kitne ka mangana", "order amount")
_ORDER_QTY = ("order qty", "order quantity", "kitna mangana", "kitna mangwana", "kitna order", "shortage",
              "shortfall", "kami", "kitne mangane")
_USE_STRONG = ("consumption", "consumed", "consume", "usage", "kharch", "khapat", "most used", "jyada use",
               "zyada use", "jada use", "use hua", "use hue", "use huye", "used most")
_USE_WEAK = ("use", "used", "issue", "issued", "issues", "nikla", "nikle", "lagaya")
_ASC = ("lowest", "least", "cheapest", "sasta", "saste", "sasti", "sabse kam", "smallest", "bottom", "kam se kam",
        "minimum value", "lowest value")
_RANK = ("top", "highest", "most", "sabse", "biggest", "largest", "max value", "maximum value", "bade", "bada",
         "badi", "costliest", "first", "pehle", "zyada se zyada") + _ASC
_COUNT = ("how many", "count", "number of", "ginti", "kitna part", "kul part", "total part", "total item")
_TOTAL = ("total", "kul", "sum", "overall", "poora", "pura", "sab ka", "sabka")
_HOWTO = ("kaise", "kaisa", "how to", "how do", "how can", "kahan milega", "kaha milega", "kidhar milega",
          "kahan se", "kaha se", "where can", "kaha pe milega", "steps")
_COMPARE = (" vs ", "versus", "compare", "comparison", "section wise", "sectionwise", "section-wise",
            "har section", "which section", "kis section", "kaunse section", "konse section", "kon se section",
            "kaun se section", "each section", "per section", "section me sabse", "sections")
_NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
              "ten": 10, "fifteen": 15, "twenty": 20, "ek": 1, "teen": 3, "char": 4, "chaar": 4, "paanch": 5,
              "panch": 5, "chhe": 6, "saat": 7, "aath": 8, "nau": 9, "das": 10, "pandrah": 15, "bees": 20}
_MONTHS = {"jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
           "june": 6, "jun": 6, "july": 7, "jul": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
           "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12}
# A section by other names than its own.
_SECTION_ALIASES = {"maint": "maintenance", "mtc": "maintenance", "mnt": "maintenance",
                    "press": "press tool room", "general": "general tool room", "gtr": "general tool room",
                    "ptr": "press tool room"}
# Part types that are also everyday words: never read as a type on their own.
_COMMON_TYPES = {"got", "file", "files", "set", "box", "all", "item", "part"}
# Cards a list shows: the number asked for, else this many, at most _MOST.
_DEFAULT_N, _MOST = 10, 25
_SHOWN = 6

# The figure a list is ranked by: (English, Hinglish) names.
_METRIC = {
    "excess_value": ("excess value", "excess value"), "excess_qty": ("excess qty", "excess qty"),
    "stock_value": ("stock value", "stock value"), "rate": ("rate", "rate"), "qty": ("stock qty", "stock"),
    "order_value": ("order value (up to max)", "order value (max tak)"),
    "order_qty": ("order qty (up to max)", "order qty (max tak)"),
    "urgency": ("how short", "kitna kam"), "consumption": ("qty used", "use hui qty"),
    "consumption_value": ("value used", "use hui value"), "min_level": ("min", "min"),
    "max_level": ("max", "max"),
}
_STATUS_HI = {
    "Out of Stock": "stock khatam (zero)", "Below Minimum": "minimum se kam", "Reorder": "reorder karna hai",
    "Above Maximum": "max se zyada (excess)", "Healthy": "theek hai", "Not Counted": "abhi gina nahi",
    "Discontinued": "discontinued (ab zarurat nahi)",
}
_STATUS_ROUTE = "/store-stock-spare"

# Every word the question-reading knows — what a misspelling is corrected
# towards, and what never narrows a part search.
_INTENT_WORDS = {
    w for phrases in ([p for _, ps in _BUCKETS for p in ps], _VALUE, _RATE, _QTY, _ORDER_VALUE, _ORDER_QTY,
                      _USE_STRONG, _USE_WEAK, _ASC, _RANK, _COUNT, _TOTAL, _HOWTO, _COMPARE)
    for p in phrases for w in p.split()
} | set(_MONTHS) | {"section", "sections", "vs", "versus", "today", "yesterday", "week", "month", "year", "lakh",
                    "crore", "above", "below", "over", "under", "more", "less", "than", "upar", "niche", "neeche",
                    "short", "order", "min", "max", "minimum", "maximum", "level", "rack", "shelf", "bin"}


# ---- small helpers ---------------------------------------------------------

def _has(text, words):
    """Does the text say any of these words / phrases — as whole words (so
    "top" is not in "laptop", "rate" not in "separate"), a plural -s / -es
    allowed?"""
    for w in words:
        w = w.strip()
        if w and re.search(rf"(?<![a-z0-9]){re.escape(w)}(?:s|es)?(?![a-z0-9])", text):
            return True
    return False


def _tokens(ql):
    """The words of a lower-cased question: punctuation around them dropped,
    the dashes / slashes / dots inside a part no or a bin kept ("R4-S6-B33")."""
    return [t.strip(".,-/") for t in re.findall(r"[\w\-./]+", ql) if t.strip(".,-/")]


def _is_code(token):
    """A part number or a bin: letters AND digits (CNTR3200, R4, B33, R4-S6-B33)."""
    return len(token) >= 2 and any(c.isalpha() for c in token) and any(c.isdigit() for c in token)


def _alnum(text):
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def _is_part_code(code):
    """Looks like a part number (CNTR3200, OLD77X): five or more letters and
    digits with at least two of each — so "m12", "12mm" or "top10" are words."""
    letters, digits = sum(c.isalpha() for c in code), sum(c.isdigit() for c in code)
    return len(code) >= 5 and letters >= 2 and digits >= 2


def _is_place(token):
    """A rack, shelf or bin, or a whole bin location: R4, S6, B33, R4-S6-B33,
    R4S6B33."""
    return bool(re.fullmatch(r"[rsb]\d{1,3}|r\d{1,3}(-+s\d*)?(-+b[\w&]*)?(\(\d+\))?|r\d{1,3}s\d{1,3}(b\d{1,3})?",
                             token))


def _place_pieces(token):
    """The rack / shelf / bin pieces a place names: R4-S6-B33 and R4S6B33 are
    {r4, s6, b33}."""
    m = re.fullmatch(r"r(\d{1,3})s(\d{1,3})(?:b(\d{1,3}))?", token)
    if m:
        return {f"r{m[1]}", f"s{m[2]}"} | ({f"b{m[3]}"} if m[3] else set())
    return {p for p in re.split(r"[^a-z0-9]+", token) if p}


def _bin_pieces(location):
    """"R4-S6-B33(1)" is R4, S6, B33 and its partition 1; "R3-S7-B40 & 41" holds B40 and 41."""
    return {p for p in re.split(r"[^a-z0-9]+", str(location or "").lower()) if p}


def _distance(a, b, limit):
    """Edits (insert, delete, change, swap two neighbours) from a to b; past
    `limit`, limit + 1."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev2, prev = None, list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        if min(cur) > limit:
            return limit + 1
        prev2, prev = prev, cur
    return prev[-1]


def _correct(token, vocab):
    """The one known word a misspelt word is closest to — same first letter,
    one edit away (two for a long word) — or None."""
    limit = 1 if len(token) <= 5 else 2
    best, best_d, tie = None, limit + 1, False
    for w in vocab:
        if w[0] != token[0] or abs(len(w) - len(token)) > limit:
            continue
        d = _distance(token, w, limit)
        if d < best_d:
            best, best_d, tie = w, d, False
        elif d == best_d and w != best:
            tie = True
    return best if best and not tie else None


def _num(x):
    """A quantity as said: 5, 2.5, 1,200 — never 5.0."""
    if x is None:
        return "—"
    x = float(x)
    return f"{int(x):,}" if x == int(x) else f"{x:,.2f}".rstrip("0").rstrip(".")


def _inr(value):
    """₹ the Indian way: ₹1,23,45,678; paise kept under ₹100 (a ₹0.40 washer)."""
    v = float(value or 0)
    if abs(v) < 100 and v != int(v):
        return f"{'-' if v < 0 else ''}₹{abs(v):.2f}"
    n = int(round(v))
    digits = str(abs(n))
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        digits = ",".join(([head] if head else []) + groups + [tail])
    return f"{'-' if n < 0 else ''}₹{digits}"


def _money(value):
    """₹ as the plant says a big figure: ₹71.4 L, ₹1.2 Cr; ₹45,600 below a lakh."""
    v = float(value or 0)
    if abs(v) >= 1e7:
        return f"₹{v / 1e7:.2f} Cr".replace(".00 ", " ")
    if abs(v) >= 1e5:
        return f"₹{v / 1e5:.1f} L".replace(".0 ", " ")
    return _inr(v)


def _allowed(service, user):
    """May this user open this screen? Mirrors the sidebar's gating: admin-only
    screens need an admin, module-gated screens need that module's view right,
    and an ungated screen is open to any signed-in user. A None user (e.g. a
    machine caller) gets only ungated screens."""
    if service.get("admin") and not (user and user.is_admin):
        return False
    mod = service.get("mod")
    if mod and not (user and user.can(mod)):
        return False
    return True


def _figure(r, metric):
    """A row's figure for a metric, None when it has none (no rate, no max …)."""
    qty, rate = r.get("qty_on_hand"), r.get("unit_price") or None
    if metric in ("excess_qty", "excess_value"):
        top = r.get("max_stock_level")
        if qty is None or top is None or qty <= top:
            return None
        over = qty - top
        return round(over, 2) if metric == "excess_qty" else (round(over * rate, 2) if rate else None)
    if metric == "stock_value":
        return r.get("stock_value")
    if metric == "rate":
        return rate
    if metric == "qty":
        return qty
    if metric == "min_level":
        return r.get("min_stock_level")
    if metric == "max_level":
        return r.get("max_stock_level")
    if metric in ("order_qty", "order_value"):
        need = r.get("shortfall")
        if need is None:
            gap = (r.get("min_stock_level") or 0) - (qty or 0)
            need = round(gap, 2) if gap > 0 else None
        if metric == "order_qty":
            return need
        return round(need * rate, 2) if (need and rate) else None
    if metric == "urgency":
        if qty is None:
            return None
        return round((r.get("min_stock_level") or 0) - qty, 2)
    return None


def _shown(metric, value, uom=""):
    """A figure as its card shows it."""
    if value is None:
        return None
    if metric in ("excess_value", "stock_value", "rate", "order_value", "consumption_value"):
        return _inr(value)
    return f"{_num(value)} {uom}".strip()


_MONEY_METRICS = ("excess_value", "stock_value", "order_value", "rate")
_UNITS = {"lakh": 1e5, "lakhs": 1e5, "lac": 1e5, "lacs": 1e5, "l": 1e5, "k": 1e3, "thousand": 1e3, "hazar": 1e3,
          "hazaar": 1e3, "cr": 1e7, "crore": 1e7, "crores": 1e7}
_UNIT_RE = r"(?P<unit>lakhs?|lacs?|l|k|thousand|hazaa?r|cr|crores?)?"
_UP = ("se upar", "se zyada", "se jyada", "se jada", "se adhik", "se mehenge", "se mehnge", "se mehenga",
       "ke upar", "above", "over", "more than", "greater than", ">")
_DOWN = ("se kam", "se niche", "se neeche", "se saste", "se sasta", "ke niche", "below", "under", "less than", "<")
_THRESHOLD_RES = (
    re.compile(r"(?P<num>\d+(?:\.\d+)?)\s*" + _UNIT_RE + r"\s*(?:rs\s*)?(?P<dir>"
               + "|".join(re.escape(d) for d in _UP + _DOWN if d[0] in "sk") + r")\b"),
    re.compile(r"\b(?P<dir>above|over|more than|greater than|below|under|less than)\s*(?:rs\s*)?(?P<num>\d+(?:\.\d+)?)"
               r"\s*" + _UNIT_RE + r"\b"),
    re.compile(r"(?P<dir>[<>])\s*(?P<num>\d+(?:\.\d+)?)\s*" + _UNIT_RE + r"\b"),
)
_LEVEL_RE = re.compile(r"\b(?P<lvl>min|minimum|max|maximum)\s*(?:level|lvl)?\s*(?:=|:|is|hai)?\s*(?P<num>\d+(?:\.\d+)?)\b")
Threshold = namedtuple("Threshold", "metric op amount")


class _Ask:
    """One question, read: its language and every piece it names."""

    def __init__(self, q, vocab=()):
        self.q = (q or "").strip()
        text = self.q.lower().translate(_DEVANAGARI_DIGITS)
        self.deva = bool(re.search(r"[ऀ-ॿ]", text))
        if self.deva:
            text = " ".join(_DEVANAGARI.get(w.strip("?।!,.\"'"), w) for w in text.split())
        text = text.replace("₹", " rs ").replace("rs.", "rs ")
        self.raw = [_SYNONYMS.get(t, t) for t in _tokens(text)]
        known = _INTENT_WORDS | _FILLER | _GREETINGS | _THANKS | _ACKS | set(vocab)
        pool = sorted(w for w in (_INTENT_WORDS | set(vocab)) if len(w) >= 4)
        self.tokens = []
        for t in self.raw:
            if t not in known and len(t) >= 4 and t.isalpha():
                t = _correct(t, pool) or t
            self.tokens.append(t)
        ql = " ".join(self.tokens)
        self.ql = f" {ql} "
        self.hi = self.deva or any(t in _HINGLISH for t in self.raw)
        self.codes = self._codes()
        self.places = self._places()
        self.thresholds, rest = self._thresholds(self.ql)
        self.levels, rest = self._levels(rest)
        self.rest = rest                                      # the text with its figures cut out
        self.n = self._number(rest)
        self.asc = _has(self.ql, _ASC) or bool(_ASC_STOCK.search(self.ql))
        self.ranked = self.n is not None or _has(self.ql, _RANK) or bool(_RANKED_STOCK.search(self.ql))
        self.count = _has(self.ql, _COUNT) or bool(_COUNT_WORD.search(self.ql))
        self.total = _has(self.ql, _TOTAL)
        self.howto = _has(self.ql, _HOWTO)
        self.compare = _has(self.ql, _COMPARE)

    def _codes(self):
        """Part numbers however typed: CNTR3200, cntr-3200, cntr_3200, "CNTR 3200"."""
        out = []
        raw = self.raw
        for i, t in enumerate(raw):
            if _is_place(t):
                continue
            joined = _alnum(t)
            if i + 1 < len(raw) and re.fullmatch(r"[a-z]{2,6}", t) and re.fullmatch(r"\d{2,6}", raw[i + 1]):
                joined = t + raw[i + 1]
            if _is_part_code(joined) and joined not in out:
                out.append(joined)
        return out

    def _places(self):
        """[(label, {pieces})]: R4, R4-S6-B33(1), r4s6b33, "rack 4", "shelf 6", "bin 33"."""
        out = []
        raw = self.raw
        for i, t in enumerate(raw):
            if _is_place(t):
                out.append((t.upper(), _place_pieces(t)))
            elif t in ("rack", "shelf", "bin") and i + 1 < len(raw) and re.fullmatch(r"\d{1,3}", raw[i + 1]):
                piece = f"{t[0]}{raw[i + 1]}"
                out.append((piece.upper(), {piece}))
        return out

    @staticmethod
    def _thresholds(text):
        """Figures past a line ("rate 500 se upar", "1 lakh se upar ka excess",
        "stock 5 se kam", "above 1 lakh value"), and the text without them."""
        found = []
        for rx in _THRESHOLD_RES:
            for m in list(rx.finditer(text)):
                amount = float(m["num"]) * _UNITS.get(m["unit"] or "", 1)
                op = ">" if m["dir"] in _UP else "<"
                before = text[:m.start()].split()[-3:]
                after = text[m.end():].split()[:3]
                near = " " + " ".join(before + after + [m["dir"]]) + " "
                if _has(near, _RATE) or "mehen" in m["dir"] or "sast" in m["dir"]:
                    metric = "rate"
                elif _has(near, ("min", "minimum")):
                    metric = "min_level"
                elif _has(near, ("max", "maximum")) and not _has(near, ("value",)):
                    metric = "max_level"
                elif _has(text, ("excess", "above max", "over max")):
                    metric = "excess_value" if (m["unit"] or _has(near, _VALUE)) else "excess_qty"
                elif _has(near, ("stock", "qty", "quantity", "maal", "pcs", "pieces", "nos")):
                    metric = "qty"
                elif m["unit"] or _has(near, _VALUE):
                    metric = "stock_value"
                else:
                    metric = "stock_value" if amount >= 1000 else "qty"
                found.append(Threshold(metric, op, amount))
                text = text[:m.start()] + " " * (m.end() - m.start()) + text[m.end():]
        return found, text

    @staticmethod
    def _levels(text):
        """A level asked for exactly ("min 10 wale part"), and the text without it."""
        found = []
        for m in list(_LEVEL_RE.finditer(text)):
            metric = "min_level" if m["lvl"].startswith("min") else "max_level"
            found.append(Threshold(metric, "=", float(m["num"])))
            text = text[:m.start()] + " " * (m.end() - m.start()) + text[m.end():]
        return found, text

    def _number(self, text):
        """The N of "top 10", "10 parts", "pehle 5", "top ten", "5 most expensive
        bearings", "sabse mehenge 5 cylinder"."""
        # A period's number is not N ("90 din", "6 months", "2026").
        text = re.sub(r"\b\d{1,3}\s*(din|days?|d|mahine|mahina|months?)\b|\b20\d\d\b", " ", text)
        for pattern in (r"\btop\s*(\d{1,3})\b", r"\b(\d{1,3})\s*(?:top|parts?|items?|wale|wala|sabse)\b",
                        r"\b(\d{1,3})\s+(?:[a-z]+\s+){1,2}(?:parts?|items?)\b",
                        r"\b(?:first|pehle|pahle|starting)\s*(\d{1,3})\b", r"\btop\s+([a-z]+)\b",
                        r"\b([a-z]+)\s+(?:parts?|items?)\b"):
            m = re.search(pattern, text)
            if not m:
                continue
            word = m.group(1)
            n = int(word) if word.isdigit() else _NUM_WORDS.get(word)
            if n:
                return max(1, min(n, _MOST))
        # A lone small number beside a ranking word: "5 most expensive bearings".
        lone = [int(x) for x in re.findall(r"(?<![\w.-])(\d{1,2})(?![\w.-])", text)]
        if len(lone) == 1 and lone[0] and _has(text, _RANK):
            return min(lone[0], _MOST)
        return None

    def smalltalk(self):
        said = set(self.tokens)
        if not said:
            return None
        if said & _GREETINGS and said <= _GREETINGS | _POLITE:
            return "greet"
        if said & _THANKS and said <= _THANKS | _POLITE:
            return "thanks"
        if said & _ACKS and said <= _ACKS | _POLITE:
            return "ack"
        return None

    def bucket(self):
        """The bucket the question names, or NOT that bucket ("jo khatam nahi
        hai", "not critical"), or None."""
        text = re.sub(r"\bsabse (zyada|jyada|jada|kam)\b", " ", _RANKED_STOCK.sub(" stock ", self.rest))
        for b, phrases in _BUCKETS:
            for p in phrases:
                m = re.search(rf"(?<![a-z0-9]){re.escape(p)}(?:s|es)?(?![a-z0-9])", text)
                if not m:
                    continue
                if set(p.split()) & _NEGATION:
                    return b
                after = text[m.end():].split()[:3]
                before = text[:m.start()].split()[-1:]
                if set(after) & _NEGATION or set(before) & {"not", "non"}:
                    return Bucket("not_" + b.key, f"Not {b.en.lower()}", f"{b.hi} nahi",
                                  lambda r, t=b.test: not t(r))
                return b
        # Bare words: "short" (unless it names a part: "short bar"), "order",
        # and "max" / "min" said alone.
        m = re.search(r"\bshort\b(?:\s+(\S+))?", text)
        if m and (m.group(1) is None or m.group(1) in _FILLER or m.group(1) in _INTENT_WORDS):
            return _BUCKET["critical"]
        if re.search(r"\borders?\b", text):
            return _BUCKET["reorder"]
        meaning = [t for t in _tokens(text) if t not in _FILLER]
        if meaning == ["max"]:
            return _BUCKET["excess"]
        if meaning == ["min"]:
            return _BUCKET["critical"]
        return None


class AssistantService:
    def __init__(self):
        self.stock = SpareStockService()

    def services(self, user=None):
        """The screen catalogue for the launcher — only screens this user may open."""
        return [s for s in SERVICES if _allowed(s, user)]

    # ---- the one entry point ----

    def ask(self, query, user=None):
        if not (query or "").strip():
            return self._reply("Type what you're looking for — a part number, a stock status "
                               "(short, reorder, excess), a report, or a screen name.", [], self._suggest("", user))
        # Stock figures only for someone who may see the spare stock: any login
        # could ask for rupee values before (security audit, 24 Oct 2026).
        # Anyone else still gets the screens they may open. (No user = the
        # machine caller; the route always passes the signed-in person.)
        from app.utils.authz import sees_spare_stock
        if user is not None and not (sees_spare_stock(user) and user.can_access_store(STORE)):
            return self._reply("Stock figures need a Spare Store right — ask the admin. "
                               "Screens you can open:", [], self._suggest((query or "").lower(), user))
        rows = self.stock.list_stock(STORE)
        sections = self._sections()
        a = _Ask(query, self._vocab(rows, sections))
        small = a.smalltalk()
        if small == "greet":
            return self._reply("Namaste! Stock, koi part number ya koi screen ke baare me pucho." if a.hi else
                               "Hello! Ask me about stock, a part number or a screen.", [], [])
        if small == "thanks":
            return self._reply("Koi baat nahi! Aur kuch puchna ho to likho." if a.hi else
                               "You're welcome! Ask me anything else.", [], [])
        if small == "ack":
            return self._reply("Theek hai! Aur kuch puchna ho to likho." if a.hi else "Okay! Ask me anything else.",
                               [], [])

        # A part number in the question is answered first: "CNTR3200 kitne ka
        # hai" is that part's rate, not the store's stock value.
        if a.codes:
            found = self._find_codes(rows, a.codes)
            if found:
                return self._parts_answer(a, found, user)

        scope = self._scope(a, rows, sections)
        bucket = a.bucket()
        figure_words = _has(a.ql, _VALUE + _RATE + _ORDER_VALUE + _ORDER_QTY)
        if a.howto and not bucket and not a.ranked and not figure_words and not a.thresholds:
            return self._howto_answer(a, user)
        if self._is_use(a, bucket):
            return self._use_answer(a, scope, user)
        if a.compare or len(scope["sections"]) > 1:
            return self._section_answer(a, rows, scope, bucket, sections, user)
        if (bucket or scope["named"] or a.ranked or a.count or a.total or figure_words or a.thresholds
                or a.levels):
            answer = self._list_answer(a, rows, scope, bucket, user)
            if answer:
                return answer

        # Only "stock" asked about ("stock kitna hai", "how much stock"): the store's summary.
        if {"stock", "maal", "inventory"} & set(a.tokens) and not self._words(a.tokens):
            return self._value_answer(a, rows, "", user)
        # Last: the words as typed, against part names ("short bar", "cutter").
        words = [t for t in a.raw if t not in _FILLER and len(t) > 1 and not _is_place(t) and not t.isdigit()]
        found = self._search_parts(rows, words)
        if found:
            return self._parts_answer(a, found, user)
        suggestions = self._suggest(" ".join(words), user) if words else []
        if suggestions:
            return self._reply(f"“{a.q}” ka stock data nahi mila, par ye screen kaam aa sakti hai:" if a.hi else
                               f"I couldn't find stock data for “{a.q}”, but these screens might help:",
                               [], suggestions)
        return self._reply(
            (f"“{a.q}” se kuch nahi mila. Aise pucho: “top 10 excess value”, “Maintenance me kya khatam hai”, "
             "“sabse mehenge 5 part”, “is mahine sabse zyada use”, “CNTR3200 kitna hai”.") if a.hi else
            (f"Nothing matched “{a.q}”. Try: “top 10 excess by value”, “what is out of stock in Maintenance”, "
             "“5 costliest parts”, “most used this month”, “CNTR3200”."),
            [], self._suggest("", user))

    # ---- WHICH parts: sections, type, place, figure lines ----

    def _sections(self):
        """[(id, name, group)] of the store's active sections."""
        from app.models.store import Section, Store
        return [(s.id, s.name, s.group_name) for s in
                Section.query.join(Store, Store.id == Section.store_id)
                .filter(Store.code == STORE, Section.is_active.is_(True))]

    @staticmethod
    def _vocab(rows, sections):
        """The store's own words a misspelling may be corrected to: section and
        part-type names."""
        words = set(_SECTION_ALIASES)
        for _, name, group in sections:
            words |= set((name or "").lower().split()) | set((group or "").lower().split())
        for r in rows:
            words |= set(re.findall(r"[a-z]{4,}", (r.get("sub_category") or "").lower()))
        return words

    @staticmethod
    def _words(tokens):
        """The words of a question that may name a part: not filler, not an
        intent word, not a place or a bare number."""
        return [t for t in tokens if t not in _FILLER and t not in _INTENT_WORDS and len(t) > 1
                and not _is_place(t) and not t.isdigit() and not re.fullmatch(r"\d+(\.\d+)?", t)]

    def _scope(self, a, rows, sections):
        """The sections, part type(s), places and figure lines the question
        names. Every section name found is blanked out of the text the type is
        looked for in, so "Tool Room" is never the part type "Tool"."""
        text = a.ql
        types = sorted({(r.get("sub_category") or "").strip() for r in rows} - {""}, key=len, reverse=True)
        kinds, kind_label = None, None

        def take_type(t):
            nonlocal text, kinds, kind_label
            tl = t.lower()
            # One word ("valve") is the whole family (Solenoid Valve, Air Valve …).
            family = [u for u in types if re.search(rf"\b{re.escape(tl)}\b", u.lower())] if " " not in tl else [t]
            kinds = {u.lower() for u in family}
            kind_label = t if len(family) == 1 else f"{t} ({len(family)} types)"
            text = re.sub(rf"\b{re.escape(tl)}s?\b", " ", text)

        # A type of more than one word first — "Press Machine Spare" is a type,
        # not the Press Tool Room; then the sections; then a one-word type.
        for t in types:
            if " " in t and re.search(rf"\b{re.escape(t.lower())}s?\b", text):
                take_type(t)
                break
        names = {}
        for sid, name, group in sections:
            names.setdefault(name.lower(), (name, set()))[1].add(sid)
            if group:
                names.setdefault(group.lower(), (group, set()))[1].add(sid)
        for alias, target in _SECTION_ALIASES.items():
            if target in names:
                names.setdefault(alias, names[target])
        found = []
        for key in sorted(names, key=len, reverse=True):
            if re.search(rf"\b{re.escape(key)}\b", text):
                if names[key][0] not in [f[0] for f in found]:
                    found.append(names[key])
                text = re.sub(rf"\b{re.escape(key)}\b", " ", text)
        # "part", "parts", "item" never name a type on their own, though the
        # store's types end in them ("Cylinder Parts", "Std Part"): "kitne parts
        # khatam hai" asked the whole store and got "Cylinder Parts" (25 Oct 2026).
        if kinds is None:
            for t in types:
                tl = t.lower()
                if " " in tl or tl in _COMMON_TYPES or tl in _FILLER:
                    continue
                if re.search(rf"\b{re.escape(tl)}s?\b", text):
                    take_type(t)
                    break
        if kinds is None:
            # A word that only ends types — "valve" for Solenoid Valve, Air Valve …
            for word in {t.lower().split()[-1] for t in types if " " in t}:
                if (len(word) >= 4 and word not in _COMMON_TYPES and word.rstrip("s") not in _FILLER
                        and re.search(rf"\b{re.escape(word)}s?\b", text)):
                    family = [t for t in types if t.lower().split()[-1] == word]
                    kinds = {t.lower() for t in family}
                    kind_label = word.title() if len(family) == 1 else f"{word.title()} ({len(family)} types)"
                    text = re.sub(rf"\b{re.escape(word)}s?\b", " ", text)
                    break
        # A named area of the store: "pipe rack", "old store".
        place_texts = []
        locations = {str(r.get("location") or "").lower() for r in rows}
        toks = _tokens(text)
        for i, t in enumerate(toks):
            if t in ("rack", "store", "area", "godown") and i > 0 and toks[i - 1] not in _FILLER:
                phrase = f"{toks[i - 1]} {t}"
                if any(phrase in loc for loc in locations):
                    place_texts.append(phrase)
                    text = text.replace(phrase, " ")
        words = [w for w in self._words(_tokens(text)) if not any(w in p for p in place_texts)]
        if found:
            ids = set().union(*(f[1] for f in found))
            section = (" · ".join(f[0] for f in found), ids)
        else:
            section = None
        return {"section": section, "sections": found, "types": kinds, "type_label": kind_label,
                "places": a.places, "place_texts": place_texts, "lines": a.thresholds + a.levels, "words": words,
                "named": bool(found or kinds or a.places or place_texts)}

    @staticmethod
    def _in_scope(r, scope):
        if scope["section"] and r.get("section_id") not in scope["section"][1]:
            return False
        if scope["types"] and (r.get("sub_category") or "").strip().lower() not in scope["types"]:
            return False
        if scope["places"]:
            bins = [_bin_pieces(v) for v in (r.get("location"), r.get("rework_location")) if v]
            if not all(any(pieces <= b for b in bins) for _, pieces in scope["places"]):
                return False
        if scope["place_texts"]:
            loc = str(r.get("location") or "").lower()
            if not all(p in loc for p in scope["place_texts"]):
                return False
        for line in scope["lines"]:
            v = _figure(r, line.metric)
            if v is None:
                return False
            if (line.op == ">" and not v > line.amount) or (line.op == "<" and not v < line.amount) or (
                    line.op == "=" and v != line.amount):
                return False
        return True

    @staticmethod
    def _line_words(line, hi):
        """A figure line as the answer names it: "rate above ₹500", "Min 10"."""
        if line.op == "=":
            return f"{_METRIC[line.metric][0].capitalize()} {_num(line.amount)}"
        money = line.metric in _MONEY_METRICS
        amount = _money(line.amount) if money else _num(line.amount)
        name = _METRIC[line.metric][1 if hi else 0]
        if hi:
            return f"{name} {amount} se {'upar' if line.op == '>' else 'kam'}"
        return f"{name} {'above' if line.op == '>' else 'below'} {amount}"

    def _scope_bits(self, scope, hi):
        """The scope as the answer names it: "Maintenance · Sensor · R4 B33 · rate above ₹500"."""
        bits = [scope["section"][0]] if scope["section"] else []
        if scope["type_label"]:
            bits.append(scope["type_label"])
        if scope["places"]:
            bits.append(" ".join(label for label, _ in scope["places"]))
        bits += [p.upper() for p in scope["place_texts"]]
        bits += [self._line_words(line, hi) for line in scope["lines"]]
        return " · ".join(bits)

    def _scope_words(self, scope, hi):
        """" (Maintenance · Sensor)" / " in Maintenance · Sensor" — after a value."""
        bits = self._scope_bits(scope, hi)
        if not bits:
            return ""
        return f" ({bits})" if hi else f" in {bits}"

    def _label(self, bucket, scope, hi):
        """The head of a list: the bucket, then the scope — "Excess (above max) —
        Solenoid Valve"; no bucket: the scope itself, or all parts."""
        bits = self._scope_bits(scope, hi)
        if bucket:
            return (bucket.hi if hi else bucket.en) + (f" — {bits}" if bits else "")
        return bits[:1].upper() + bits[1:] if bits else ("Saare part" if hi else "All parts")

    # ---- BY WHAT, HOW MANY: a ranked list of parts ----

    @staticmethod
    def _metric(a, bucket):
        key = bucket.key if bucket else None
        ql = a.ql
        if key == "excess":
            explicit_qty = _has(ql, ("qty", "quantity", "pieces", "pcs", "nos", "kitna zyada", "kitne zyada"))
            return "excess_qty" if explicit_qty and not _has(ql, _VALUE) else "excess_value"
        if _has(ql, _ORDER_VALUE):
            return "order_value"
        if _has(ql, _ORDER_QTY):
            return "order_qty"
        if key in ("reorder", "critical", "out", "below_min", "low"):
            return "order_value" if _has(ql, _VALUE) else "urgency"
        if key in ("no_rate", "no_minmax", "no_location"):
            return "qty"
        if _has(ql, _RATE):
            return "rate"
        if _has(ql, _VALUE):
            return "stock_value"
        if (_has(ql, _QTY) and a.ranked) or _RANKED_STOCK.search(ql):
            return "qty"
        lines = [t.metric for t in a.thresholds if t.metric in _METRIC and t.metric not in ("min_level", "max_level")]
        if lines:
            return lines[0]
        if key == "not_counted":
            return "rate"
        return "stock_value"

    def _list_answer(self, a, rows, scope, bucket, user):
        """Parts in the scope and bucket, ranked by the figure asked for:
        the count and the money in a sentence, the top N as cards. Asked for
        a value or a total alone ("total stock value", "Maintenance ki
        value"): the sum. A place or a type with nothing to rank ("R4 me kya
        hai", "sensor dikhao"): every part there, by location."""
        metric = self._metric(a, bucket)
        # An order value / qty with no bucket named is the reorder list's: a
        # healthy part's way up to max is not an order anyone raises.
        if bucket is None and metric in ("order_value", "order_qty"):
            bucket = _BUCKET["reorder"]
        picked = [r for r in rows if self._in_scope(r, scope) and (bucket is None or bucket.test(r))]
        # Other words in the question narrow it to the parts whose names hold them
        # ("fiber sensor", "m12 sensor") — when any part does.
        if scope["words"]:
            narrowed = self._search_parts(picked, scope["words"])
            if narrowed:
                picked = narrowed
            elif bucket is None and not a.ranked and not scope["lines"]:
                return None
        label = self._label(bucket, scope, a.hi)
        asks_figure = _has(a.ql, _VALUE + _RATE + _ORDER_VALUE + _ORDER_QTY) or bool(_RANKED_STOCK.search(a.ql))

        # A sum, not a list: a value (or a scope's total, or "how many parts" of
        # the whole store) asked for with nothing to rank.
        plain = not a.ranked and bucket is None and not scope["lines"]
        if plain and metric == "stock_value" and (
                (not a.count and (_has(a.ql, _VALUE) or (a.total and scope["named"])))
                or (a.count and not scope["named"])):
            return self._value_answer(a, picked, self._scope_words(scope, a.hi), user)
        # A listing: a place or a type, nothing to rank them by.
        if plain and not asks_figure:
            if not picked:
                return None
            if len(picked) == 1:
                return self._parts_answer(a, picked, user)
            picked.sort(key=lambda r: (str(r.get("location") or "~"), str(r.get("part_no") or "")))
            shown = picked[:a.n or _DEFAULT_N]
            more = f" — {'pehle' if a.hi else 'the first'} {len(shown)}" if len(picked) > len(shown) else ""
            unit = "part" if a.hi or len(picked) == 1 else "parts"
            return self._reply(f"{label}: {len(picked):,} {unit}{more}:", [self._row_result(r) for r in shown],
                               self._suggest("stock", user))

        count = len(picked)
        if not count:
            return self._reply(f"{label}: abhi koi part nahi." if a.hi else f"{label}: none right now.",
                               [], self._suggest_for(bucket, user))
        known = [(r, v) for r, v in ((r, _figure(r, metric)) for r in picked) if v is not None]
        # Why a part has no money figure: no rate, or (stock value) not counted.
        priced = metric in _MONEY_METRICS
        unrated = sum(1 for r in picked if not r.get("unit_price")) if priced else 0
        uncounted = (sum(1 for r in picked if r.get("unit_price") and r.get("qty_on_hand") is None)
                     if metric == "stock_value" else 0)
        total = sum(v for _, v in known) if metric in ("excess_value", "stock_value", "order_value", "order_qty") \
            else None
        # Nothing carries the figure (a type whose parts have no rate): rank by
        # stock instead, and say so.
        fallback = not known and metric != "qty"
        if fallback:
            metric = "qty"
            known = [(r, v) for r, v in ((r, _figure(r, "qty")) for r in picked) if v is not None]
        en_name, hi_name = _METRIC[metric]
        order = sorted(known, key=lambda rv: ((rv[1] if a.asc else -rv[1]), str(rv[0].get("part_no") or "")))
        top = order[:a.n or (_SHOWN if a.count and not a.ranked else _DEFAULT_N)]

        unit = "part" if a.hi or count == 1 else "parts"
        head = f"{label}: {count:,} {unit}"
        if total and metric == "order_qty":
            head += f" — kul {_num(total)} mangana hai" if a.hi else f" — {_num(total)} to order in all"
        elif total:
            head += f" — kul {hi_name} {_money(total)}" if a.hi else f" — {_money(total)} {en_name} in all"
        head += "."
        if unrated or uncounted:
            if a.hi:
                why = ", ".join(b for b in (f"{unrated:,} ki rate nahi hai" if unrated else "",
                                            f"{uncounted:,} gine nahi gaye" if uncounted else "") if b)
                head += f" ({why} — unki value nahi judi.)"
            else:
                why = ", ".join(b for b in (f"{unrated:,} {'has' if unrated == 1 else 'have'} no rate" if unrated else "",
                                            f"{uncounted:,} not counted" if uncounted else "") if b)
                head += f" ({why} — no value for them.)"
        if fallback:
            head += " Kisi ki value nahi hai, isliye stock ke hisaab se:" if a.hi else " None has a value, so by stock:"
        elif top:
            # Asked for THE one ("sabse mehenga part", "costliest part"): name it.
            if a.n is None and _has(a.ql, ("sabse", "most", "costliest", "cheapest", "highest", "lowest")):
                r, v = top[0]
                figure = _shown(metric, v, r.get("uom") or "") if metric != "urgency" else f"{_num(v)} short"
                name = (f"{r.get('part_no')} ({(r.get('part_name') or '').strip()})" if r.get("part_name")
                        else r.get("part_no"))
                head += f" {'Sabse upar' if a.hi else 'First'}: {name} — {figure}."
            if a.hi:
                head += (f" {'Sabse kam' if a.asc else 'Top'} {len(top)}, {hi_name} ke hisaab se:"
                         if metric != "urgency" else f" Sabse zyada kam wale {len(top)}:")
            else:
                head += (f" {'Lowest' if a.asc else 'Top'} {len(top)} by {en_name}:" if metric != "urgency"
                         else f" The {len(top)} furthest short:")
        cards = [self._card(r, metric, v, i + 1) for i, (r, v) in enumerate(top)]
        return self._reply(head, cards, self._suggest_for(bucket, user))

    def _section_answer(self, a, rows, scope, bucket, sections, user):
        """One line per section ("section wise", "kis section me sabse zyada
        excess", "maintenance vs tool room"): each one's count and money,
        most first. The sections named, or else every active one."""
        metric = self._metric(a, bucket)
        if bucket is None and metric in ("order_value", "order_qty"):
            bucket = _BUCKET["reorder"]
        money = metric if metric in ("excess_value", "stock_value", "order_value") else None
        groups = scope["sections"] if len(scope["sections"]) > 1 else [(name, {sid}) for sid, name, _ in sections]
        inner = dict(scope, section=None)
        lines = []
        for name, ids in groups:
            picked = [r for r in rows if r.get("section_id") in ids and self._in_scope(r, inner)
                      and (bucket is None or bucket.test(r))]
            total = sum(v for v in (_figure(r, money) for r in picked) if v is not None) if money else None
            lines.append((name, len(picked), total))
        lines.sort(key=lambda g: (-(g[2] or 0), -g[1], g[0]))
        what = (bucket.hi if a.hi else bucket.en) if bucket else ("Saare part" if a.hi else "All parts")
        rest = self._scope_bits(dict(inner, sections=[]), a.hi)
        what += f" — {rest}" if rest else ""

        def said(name, n, total):
            unit = "part" if a.hi or n == 1 else "parts"
            return f"{name} {_money(total)} ({n:,} {unit})" if money else f"{name} {n:,} {unit}"

        head = f"{what}, {'section-wise' if a.hi else 'by section'}: " + " · ".join(said(*g) for g in lines) + "."
        if lines and (lines[0][2] or lines[0][1]):
            head += f" {'Sabse zyada' if a.hi else 'Most'}: {lines[0][0]}."
        cards = [{"title": name, "subtitle": f"{n:,} {'part' if a.hi or n == 1 else 'parts'}", "detail": "",
                  "right": None, "metric": _money(total) if money else f"{n:,}", "rank": i + 1,
                  "route": _STATUS_ROUTE, "kind": "part"} for i, (name, n, total) in enumerate(lines)]
        return self._reply(head, cards, self._suggest_for(bucket, user))

    def _value_answer(self, a, rows, where, user):
        valued = [r for r in rows if r.get("stock_value") is not None]
        counted = [r for r in rows if r.get("qty_on_hand") is not None]
        val = round(sum(r["stock_value"] for r in valued), 2)
        if a.hi:
            answer = (f"Gine hue stock ki kul value{where} {_inr(val)} hai — {len(valued):,} part ki rate ke "
                      f"saath. {len(rows):,} me se {len(counted):,} part gine ja chuke hain.")
        else:
            answer = (f"Total counted stock value{where} is {_inr(val)} across {len(valued):,} priced parts. "
                      f"{len(counted):,} of {len(rows):,} parts are counted.")
        results = [{
            "title": "Stock value", "subtitle": f"{len(valued):,} parts carry a rate",
            "right": f"₹{val:,.0f}", "route": _STATUS_ROUTE, "kind": "stat",
        }]
        return self._reply(answer, results, self._suggest("stock value", user))

    def _howto_answer(self, a, user):
        words = [w for w in self._words(a.raw) if w not in ("kaise", "kare", "karo", "karna")]
        suggestions = self._suggest(" ".join(words), user) if words else []
        if suggestions:
            return self._reply("Ye screen kaam aayegi:" if a.hi else "This screen will help:", [], suggestions)
        return self._reply("Is kaam ki screen nahi mili — sidebar me dekho, ya screen ka naam likho." if a.hi else
                           "I couldn't find a screen for that — try the sidebar, or type the screen's name.",
                           [], self._suggest("", user))

    # ---- consumption ----

    @staticmethod
    def _is_use(a, bucket):
        if _has(a.ql, _USE_STRONG):
            return True
        weak = any(t in _USE_WEAK for t in a.tokens)
        return bool(weak and bucket is None and (a.ranked or a.count or a.total or AssistantService._period(a)[2]))

    @staticmethod
    def _period(a):
        """(date_from, date_to, said) of the consumption asked for; the last 30
        days when none is named (said = None)."""
        from app.services.spare_report_service import plant_today
        today = plant_today()
        ql = a.ql
        m = re.search(r"\b(\d{1,3})\s*(din|days?|d)\b", ql)
        if m:
            days = max(1, int(m.group(1)))
            return today - timedelta(days=days - 1), today, (f"last {days} days", f"pichhle {days} din")
        m = re.search(r"\b(\d{1,2})\s*(mahine|mahina|months?)\b", ql)
        if m:
            days = 30 * max(1, int(m.group(1)))
            return today - timedelta(days=days - 1), today, (f"last {m.group(1)} months", f"pichhle {m.group(1)} mahine")
        year = re.search(r"\b(20\d\d)\b", ql)
        month = next((n for t, n in _MONTHS.items() if re.search(rf"\b{t}\b", ql)), None)
        if month:
            y = int(year.group(1)) if year else (today.year if month <= today.month else today.year - 1)
            first = date(y, month, 1)
            last = (date(y + (month == 12), month % 12 + 1, 1) - timedelta(days=1))
            name = f"{first:%B %Y}"
            return first, min(last, today), (name, f"{name} me")
        if year:
            y = int(year.group(1))
            return date(y, 1, 1), min(date(y, 12, 31), today), (str(y), f"{y} me")
        if _has(ql, ("aaj", "today")):
            return today, today, ("today", "aaj")
        if _has(ql, ("yesterday", "kal")):
            day = today - timedelta(days=1)
            return day, day, ("yesterday", "kal")
        if _has(ql, ("last month", "pichhle mahine", "pichle mahine", "pichla mahina", "previous month")):
            last = today.replace(day=1) - timedelta(days=1)
            return last.replace(day=1), last, ("last month", "pichhle mahine")
        if _has(ql, ("this month", "is mahine", "is month", "current month", "iss mahine")):
            return today.replace(day=1), today, ("this month", "is mahine")
        if _has(ql, ("this week", "is hafte", "is week", "week", "hafte")):
            return today - timedelta(days=6), today, ("last 7 days", "pichhle 7 din")
        if _has(ql, ("this year", "is saal", "year", "saal")):
            return today.replace(month=1, day=1), today, ("this year", "is saal")
        return today - timedelta(days=29), today, None

    def _use_answer(self, a, scope, user):
        first, last, said = self._period(a)
        label_en, label_hi = said or ("last 30 days", "pichhle 30 din")
        used = self.stock.top_consumed(STORE, limit=5000, date_from=first.isoformat(), date_to=last.isoformat())
        facts = {str(r.get("part_no")): r for r in self.stock.list_stock(STORE)}
        metric = "consumption_value" if _has(a.ql, _VALUE + _RATE) else "consumption"
        rows = []
        for u in used:
            r = facts.get(str(u["part_no"])) or {"part_no": u["part_no"], "part_name": u.get("part_name")}
            if not self._in_scope(r, dict(scope, lines=[])):
                continue
            rate = r.get("unit_price") or None
            value = round(u["qty"] * rate, 2) if rate else None
            rows.append((r, u["qty"], value))
        where = self._scope_words(dict(scope, lines=[]), a.hi)
        if not rows:
            return self._reply(f"{label_hi[:1].upper() + label_hi[1:]}{where} koi part issue nahi hua." if a.hi else
                               f"No parts were issued{where} — {label_en}.", [], self._suggest("consumption", user))
        key = (lambda t: (t[2] is None, -(t[2] or 0))) if metric == "consumption_value" else (lambda t: -t[1])
        rows.sort(key=key)
        if a.asc:
            rows.reverse()
        n = a.n or _DEFAULT_N
        qty = sum(t[1] for t in rows)
        value = sum(t[2] for t in rows if t[2] is not None)
        if a.hi:
            head = (f"{label_hi[:1].upper() + label_hi[1:]}{where} {len(rows):,} part issue hue, kul {_num(qty)} qty"
                    + (f", value {_money(value)}" if value else "") + "."
                    + f" {_METRIC[metric][1].capitalize()} ke hisaab se {'sabse kam' if a.asc else 'top'} "
                    + f"{min(n, len(rows))}:")
        else:
            head = (f"{label_en[:1].upper() + label_en[1:]}{where}: {len(rows):,} parts issued, {_num(qty)} in all"
                    + (f", {_money(value)} at today's rate" if value else "") + "."
                    + f" {'Lowest' if a.asc else 'Top'} {min(n, len(rows))} by {_METRIC[metric][0]}:")
        cards = []
        for i, (r, q, v) in enumerate(rows[:n]):
            card = self._card(r, metric, v if metric == "consumption_value" else q, i + 1)
            card["detail"] = " · ".join(b for b in (
                f"Used {_num(q)} {r.get('uom') or ''}".strip(), _inr(v) if v else None, r.get("location")) if b)
            cards.append(card)
        return self._reply(head, cards, self._suggest("consumption", user))

    # ---- a part (or several) by number or name ----

    def _parts_answer(self, a, rows, user):
        """One part: a sentence with its stock, bins, levels and rate. Several:
        how many, and their cards."""
        results = [self._row_result(r) for r in rows[:_DEFAULT_N]]
        if len(rows) == 1:
            return self._reply(self._part_sentence(rows[0], a.hi), results, self._suggest(a.ql.strip(), user))
        n = len(rows)
        shown = min(n, _DEFAULT_N)
        if n <= 3 and a.codes:
            # Two or three part numbers asked together: a sentence each.
            return self._reply(" ".join(self._part_sentence(r, a.hi) for r in rows), results,
                               self._suggest(a.ql.strip(), user))
        if a.hi:
            answer = f"“{a.q}” se milte {n:,} part mile" + (f" — pehle {shown}:" if n > shown else ":")
        else:
            answer = f"Found {n:,} parts matching “{a.q}”" + (f" — the first {shown}:" if n > shown else ".")
        return self._reply(answer, results, self._suggest(a.ql.strip(), user))

    @staticmethod
    def _part_sentence(r, hi):
        pn, name, uom = r.get("part_no"), (r.get("part_name") or "").strip(), (r.get("uom") or "").strip()
        named = f"{pn} ({name})" if name else pn
        bins = [b for b in (r.get("location"), r.get("rework_location")) if b]
        if len(bins) == 2:
            where = f"new {bins[0]}, rework {bins[1]}"
        else:
            where = bins[0] if bins else None
        qty, status = r.get("qty_on_hand"), r.get("status")
        levels = f"Min {_num(r.get('min_stock_level'))}, Max {_num(r.get('max_stock_level'))}"
        rate = r.get("unit_price")
        if hi:
            if qty is None:
                text = f"{named} abhi tak gina nahi gaya"
            else:
                text = f"{named} ka stock {_num(qty)} {uom} hai".replace("  ", " ")
            text += f", location {where}." if where else ", location abhi bhari nahi hai."
            text += f" {levels}."
            if rate:
                text += f" Rate {_inr(rate)}."
            if status and qty is not None:
                text += f" Status: {_STATUS_HI.get(status, status)}."
            return text
        if qty is None:
            text = f"{named} has not been counted yet"
        else:
            text = f"{named}: {_num(qty)} {uom} in stock".replace("  ", " ")
        text += f", at {where}." if where else ", no location set."
        text += f" {levels}."
        if rate:
            text += f" Rate {_inr(rate)}."
        if status and qty is not None:
            text += f" Status: {status}."
        return text

    @staticmethod
    def _find_codes(rows, codes):
        """Parts the question's part numbers point at, each code on its own (two
        part numbers = two parts): the part number itself (or its old / new
        number), else those starting with it, else (a long code) those holding
        it. Letters and digits only on both sides: CNTR-3200 is CNTR3200."""
        ids = [(r, [_alnum(v) for v in (r.get("part_no"), r.get("old_part_no"), r.get("new_part_no")) if v])
               for r in rows]
        out, seen = [], set()
        for code in codes:
            hits = [r for r, i in ids if code in i]
            if not hits:
                hits = sorted((r for r, i in ids if any(x.startswith(code) for x in i)),
                              key=lambda r: str(r.get("part_no") or ""))
            if not hits and len(code) >= 6:
                hits = sorted((r for r, i in ids if any(code in x for x in i)),
                              key=lambda r: str(r.get("part_no") or ""))
            for r in hits:
                if id(r) not in seen:
                    seen.add(id(r))
                    out.append(r)
        return out

    @staticmethod
    def _search_parts(rows, words):
        """Parts whose number, name, specification or bins hold every word — a
        short word (3 letters or fewer: "m12", "ok") only as a whole word."""
        if not words:
            return []
        tests = [re.compile(rf"(?<![a-z0-9]){re.escape(w)}(?![a-z0-9])") if len(w) <= 3 else None for w in words]
        out = []
        for r in rows:
            hay = " ".join(str(r.get(k) or "") for k in (
                "part_no", "old_part_no", "new_part_no", "part_name", "specification", "location",
                "rework_location", "sub_category")).lower()
            if all((t.search(hay) if t else w in hay) for w, t in zip(words, tests)):
                out.append(r)
        return out

    # ---- cards ----

    @staticmethod
    def _card(r, metric, value, rank):
        """A part as a ranked card: the figure asked for on the right, the
        status and where it sits underneath."""
        uom = r.get("uom") or ""
        bits = []
        if metric in ("excess_value", "excess_qty"):
            bits.append(f"Stock {_num(r.get('qty_on_hand'))} / Max {_num(r.get('max_stock_level'))}")
            if metric == "excess_value":
                bits.append(f"{_num(_figure(r, 'excess_qty'))} over")
        elif metric in ("order_value", "order_qty", "urgency"):
            bits.append(f"Stock {_num(r.get('qty_on_hand'))} / Min {_num(r.get('min_stock_level'))}"
                        f" / Max {_num(r.get('max_stock_level'))}")
            need = _figure(r, "order_qty")
            if need and metric != "order_qty":
                bits.append(f"order {_num(need)}")
        elif metric in ("stock_value", "rate"):
            bits.append(f"Stock {_num(r.get('qty_on_hand'))} × {_inr(r['unit_price'])}" if r.get("unit_price")
                        else f"Stock {_num(r.get('qty_on_hand'))}")
        elif metric == "qty":
            bits.append(f"Min {_num(r.get('min_stock_level'))} / Max {_num(r.get('max_stock_level'))}")
        if r.get("location"):
            bits.append(r["location"])
        shown = _shown(metric, value, uom)
        if metric == "urgency":
            shown = f"{_num(value)} short" if value and value > 0 else "at min"
        return {
            "title": r.get("part_no"), "subtitle": r.get("part_name") or "", "detail": " · ".join(bits),
            "right": r.get("status"), "metric": shown, "rank": rank,
            "route": f"/parts?keyword={quote(str(r.get('part_no') or ''))}", "kind": "part",
        }

    @staticmethod
    def _row_result(r):
        bits = []
        if r.get("qty_on_hand") is not None:
            bits.append(f"In stock {r['qty_on_hand']:,.0f}")
        if r.get("location"):
            bits.append(r["location"])
        return {
            "title": r.get("part_no"),
            "subtitle": r.get("part_name") or "",
            "detail": " · ".join(bits),
            "right": r.get("status"),
            "route": f"/parts?keyword={quote(str(r.get('part_no') or ''))}",
            "kind": "part",
        }

    # ---- helpers ----

    def _suggest_for(self, bucket, user):
        key = bucket.key.replace("not_", "") if bucket else ""
        return self._suggest({"excess": "excess", "reorder": "reorder", "critical": "critical",
                              "out": "critical", "below_min": "reorder", "low": "reorder"}.get(key, "stock"), user)

    @staticmethod
    def _suggest(ql, user=None, limit=3):
        """Screens whose title/keywords overlap the query — the "did you mean this
        page?" chips, limited to screens the user may actually open."""
        pool = [s for s in SERVICES if _allowed(s, user)]
        tokens = [t for t in ql.split() if len(t) > 1]
        if not tokens:
            picks = [s for s in pool if s["key"] in ("store_stock", "scan_part", "part_master")]
        else:
            scored = []
            for s in pool:
                hay = (s["title"] + " " + " ".join(s["keywords"])).lower()
                score = sum(1 for t in tokens if t in hay)
                # A whole-phrase hit on the title ranks a screen higher.
                if ql.strip() and ql.strip() in hay:
                    score += 2
                if score:
                    scored.append((score, s))
            scored.sort(key=lambda x: x[0], reverse=True)
            picks = [s for _, s in scored[:limit]]
        return [{"title": s["title"], "route": s["route"], "icon": s["icon"]} for s in picks[:limit]]

    @staticmethod
    def _reply(answer, results, suggestions):
        return {"answer": answer, "results": results, "suggestions": suggestions}
