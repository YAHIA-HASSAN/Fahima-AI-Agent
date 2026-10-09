# فهيمة — مستشارة أعمال للمشروعات الصغيرة

تطبيق فهيمة الحالي موجود مباشرة في جذر المشروع. يستخدم Gemini للتفكير واختيار الأدوات، وخدمات Node.js للتحقق والحساب والحفظ في SQLite، مع Serper للبحث.

## التشغيل

```powershell
npm install
npm run doctor
npm start
```

افتحي العنوان الذي يظهره الخادم. يقرأ التطبيق الإعدادات من `.env` في جذر المشروع، ويستخدم قاعدة البيانات المحددة في `DB_PATH`. انسخي `.env.example` إلى `.env` واضبطي مفاتيح Gemini وSerper حسب الحاجة.

## الاختبارات

```powershell
npm test
npm run doctor
```

الاختبارات المعتادة تعمل على قواعد بيانات معزولة. اختبارات المزود الحي اختيارية وقد تستهلك الحصة:

```powershell
npm run test:live
npm run test:live:plan
npm run test:live:tts
```

اختبار التخطيط الحي يعطّل تسجيل المعاملات. وقد ينتج خطة مبدئية إذا لم يقدم البحث أسعارًا موثوقة.

## البنية

- `src/agent/`: حلقة الوكيل والمنسق والمهام الدائمة.
- `src/tools/`: مخطط الأدوات والتحقق من مدخلاتها وصلاحياتها.
- `src/domain/`: المعاملات والمخزون والبحث والخطط.
- `src/database/` و`src/memory/`: SQLite وذاكرة المشروع.
- `src/server/`: واجهات HTTP وتسليم المحادثات.
- `src/public/`: واجهة عربية وصوت المتصفح.
- `tests/`: اختبارات الوكيل والمجالات وواجهات HTTP والهجرة والاستعادة.

تفاصيل الاستعادة والقيود الحالية في [docs/cutover-and-recovery.md](docs/cutover-and-recovery.md)، وتدفق التنفيذ في [docs/architecture.md](docs/architecture.md).
