# omp-zen-vpn

إضافة (extension) لـ **omp** تحوّل كل ترافيك `opencode-zen` عبر بروكسي CONNECT محلي يدوّر عشرات عناوين IP مجانية، لتجاوز حدّ المعدل (rate limit) المفروض على عنوان IP الواحد في نماذج opencode-zen المجانية.

هذه نسخة محدّثة من بروكسي الـ VPN القديم (كان scripts/ps1 + proxy.js) — هنا كل المنطق في ملف `index.ts` واحد يُحمَّل كإضافة omp.

## المشكلة التي تحلّها

نماذج opencode-zen المجانية **تحدّ بالـ IP** (عضو الفريق في anomalyco/opencode#10420: *"This ratelimiting is done via ip"*). IP محروق يُرجع `429` مع `retry-after` بساعات. لذلك لا يكفي بروكسي عشوائي — يجب استخدام فقط IPs مُتحقَّق منها ضد zen نفسها في هذه اللحظة.

## الحل

- تجمع المصادر الستّ (proxyscrape http+socks5، TheSpeedX http+socks5، proxifly http+socks5) ~4000 مرشّح.
- تفحص كل مرشّح فعلياً عبر zen (`/zen/v1/models` GET + `/zen/v1/chat/completions` POST). ما ينجح (غير محروق، غير MITM) يُضاف للكاش النظيف.
- **تدوير لكل اتصال (CONNECT):** كل طلب يخرج عبر IP مختلف → IP محروق لا يلتصق أبداً.
- **مراقب كل 10 ثوانٍ** يعيد فحص IP النشط ويبدّله فور احتراقه أثناء الجلسة.
- **فترة تبريد ساعة** للـ IPs المحروقة قبل إعادة فحصها.
- **تجديد الكاش كل 3 دقائق** (re-verify) + **احتياط متدهور** (fallback) عند انقطاع الإنترنت حتى لا يتجمّد الطلب للأبد.

> ملاحظة: الكاش النشط ~6-10 IPs نظيفة في لحظة معيّنة (لا "عدد لا يحصى")، لأن معظم الـ 4000 محروقة أو ميتة عند zen. البروكسي يعيد اكتشاف النظيف منها باستمرار.

## التثبيت

1. انسخ `index.ts` إلى:
   ```
   ~/.omp/agent/extensions/omp-zen-vpn/index.ts
   ```
   (أنشئ مجلد `extensions/omp-zen-vpn` إن لم يوجد). تُحمَّل الإضافة تلقائياً عند إقلاع omp.

2. أضف إلى `~/.omp/agent/config.yml`:
   ```yaml
   retry:
     enabled: true
     maxRetries: 5
     baseDelayMs: 1000
     maxDelayMs: 30000
   tools:
     approvalMode: yolo
     approval:
       Bash: allow
       Read: allow
       Write: allow
       Edit: allow
       Glob: allow
       Grep: allow
       WebFetch: allow
       WebSearch: allow
       Task: allow
       TodoWrite: allow
       Skill: allow
       Question: allow
   ```

3. أعد تشغيل omp. كل جلسة = بروكسي مستقل بـ IP مختلف عن الجلسات الأخرى.

## كيف تعمل مع omp

الإضافة لا تعدّل سلوك omp — فقط تضبط متغيّر `PI_PROXY_OPENCODE_ZEN` ليوجّه كل ترافيك opencode-zen عبر البروكسي المحلي. تبديل IP شفاف وآلي (دوران لكل اتصال). عند انقطاع الإنترنت يحتفظ البروكسي بالطلب ويعيد التدوير عند العودة.

## التحقق

شغّل جلسة واستخدم:
```
curl -s https://api.ipify.org
```
مرّتين — كل مرة بـ IP خارجي مختلف (عبر تدوير البروكسي).

## الترخيص

ملكك للاستخدام الشخصي.
