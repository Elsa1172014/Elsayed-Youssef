import { AppShell } from "@/components/AppShell";
import { PrivacyActions } from "@/components/PrivacyActions";
import { getAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const POLICY = (
  <div className="space-y-4 leading-loose">
    <p className="rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm">
      هذا نص تعريفي بما يفعله النظام تقنيًا. <strong>يجب أن يراجعه مسؤول حماية البيانات/الحماية في مدرستك ويكمله بالمعلومات القانونية</strong> (الجهة المسؤولة، مدة الاحتفاظ المعتمدة، أساس المعالجة، موافقة ولي الأمر) قبل استخدامه مع الطلاب.
    </p>
    <h2 className="text-xl font-bold">ما الذي نجمعه؟</h2>
    <ul className="list-disc ps-6">
      <li>الاسم الظاهر (الاسم الأول أو اسم مستعار) والصف الدراسي والبريد المستخدم لتسجيل الدخول فقط. لا نطلب رقم هاتف ولا تاريخ ميلاد ولا صورًا شخصية.</li>
      <li>نشاط التعلّم: الجلسات، ونصّ المحادثة المكتوبة والمنطوقة (إن سمحتَ بحفظه)، وإجاباتك على التمارين، وتقديرات المهارات الآلية، واعتمادات المعلّم.</li>
      <li><strong>الكاميرا:</strong> لا نحفظ الصور. تُعالَج لحظة الالتقاط في الذاكرة فقط للتعرّف على صفحة الكتاب، ولا يُحفظ سوى رقم الصفحة المعتمدة.</li>
      <li><strong>الصوت:</strong> لا نحفظ تسجيلات صوتية. يُرسَل الصوت مباشرة إلى مزوّد خدمة الكلام لمعالجته أثناء المحادثة، ونحفظ النص المفرَّغ فقط إن سمحتَ بذلك.</li>
      <li>عدّادات استخدام (لتطبيق الحدود اليومية) وسجلّ تدقيق للإجراءات الإدارية دون محتوى المحادثات.</li>
    </ul>
    <h2 className="text-xl font-bold">المدة والحذف</h2>
    <ul className="list-disc ps-6">
      <li>يُزال نصّ المحادثات الأقدم من مدة الاحتفاظ المضبوطة (الافتراضي ٩٠ يومًا) تلقائيًا مع بقاء البيانات الوصفية.</li>
      <li>يمكنك في أي وقت: إيقاف حفظ النص، وتنزيل بياناتك، وحذف سجلّ تعلّمك. حذف الحساب كاملًا يتم عبر مسؤول المدرسة.</li>
    </ul>
    <h2 className="text-xl font-bold">المزوّدون والتدريب</h2>
    <p>تُرسَل النصوص والصور اللحظية والصوت إلى مزوّد النماذج لتوليد الإجابات مع طلب عدم تخزين الاستجابات. لا نستخدم محتوى الطلاب لتدريب أي نموذج، وسياسة المزوّد نفسه تخضع لاتفاقية المدرسة معه.</p>
    <h2 className="text-xl font-bold">الذكاء الاصطناعي ودقّته</h2>
    <p>المعلّم الآلي قد يخطئ. الاقتباسات من الكتاب تُتحقَّق آليًا من نصّه، أما الشرح فمن إنتاج النموذج. تقديرات المهارات تقريبية وليست درجات، والمعلّم هو من يعتمد التقييم.</p>
    <h2 className="text-xl font-bold">سلامتك</h2>
    <p>إذا كتبتَ أو قلتَ ما يدل على أنك في خطر أو حزين جدًا، يُنبَّه معلّمك آليًا ليساعدك. تحدّث دائمًا مع شخص بالغ تثق به.</p>
  </div>
);

export default async function PrivacyPage() {
  const auth = await getAuth();
  const body = (
    <>
      <h1 className="mb-4 text-3xl font-bold">الخصوصية وبياناتك</h1>
      {POLICY}
      {auth && (
        <div className="mt-8">
          <h2 className="mb-3 text-xl font-bold">تحكّم في بياناتك</h2>
          <PrivacyActions retain={auth.profile.allow_transcript_retention} />
        </div>
      )}
    </>
  );
  return auth ? <AppShell role={auth.profile.role} name={auth.profile.display_name}>{body}</AppShell> : <main className="mx-auto max-w-3xl px-4 py-10">{body}</main>;
}
