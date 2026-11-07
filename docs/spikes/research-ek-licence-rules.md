# EK's rules on student work, for the repo's licence

Research for issue #62. It feeds ADR-0002 Q7 (the licence, chosen at go-public, #38): "Chosen
when the repo goes public, after checking EK's rules on student work. With none, all rights are
reserved." This note collects what EK and Danish law say about who owns a bachelor project's code
and about publishing it. It makes **no licence recommendation**.

Labels on every claim:

- **Documented**: quoted from a primary source, with its URL and the date it was checked.
- **Repo record**: read from this repo.
- **Inference**: my reading, not stated by any source. Treat it as a question, not a fact.

Danish quotes are followed by an English translation (mine).

## Short answer

- **Documented.** The national exam order gives the student the copyright in what an exam
  produces, "in accordance with the copyright act", unless outside parties take part (§ 49).
- **Documented.** Danish copyright law treats computer programs as literary works, and the author
  holds the exclusive right to copy them and make them available, and can transfer those rights.
- **Documented, by absence.** EK's public study regulation for PBA Webudvikling, its study and
  exam rules, and the public pages of its student intranet say nothing about licensing or
  publishing student work, and nothing that limits § 49.
- **Inference.** Nothing found stops the student from choosing a licence for code they wrote
  alone without a company partner. Some practical questions remain open (see "What the sources
  leave unclear"); they are worth one email to EK before go-public.

## Sources checked (7 Nov 2026)

| Source | Owner | URL |
|---|---|---|
| Studieordning, Professionsbachelor i webudvikling, in force 1 Aug 2026, version 1 | EK | <https://www.ek.dk/media/u0idnhn3/webudvikling-ek-2026.pdf> |
| Studie- og eksamensregler for EK (fuldtidsuddannelserne), in force 1 Mar 2026 | EK | <https://www.ek.dk/media/y22ab3qp/studie-og-eksamensregler-for-ek-fuldtidsuddannelser.pdf> |
| "Love og regler" (index of regulations and orders) | EK | <https://www.ek.dk/om-os/love-og-regler> |
| BEK nr. 624 af 02/06/2025, eksamensbekendtgørelsen | Uddannelses- og Forskningsministeriet | <https://www.retsinformation.dk/eli/lta/2025/624> (PDF: <https://www.retsinformation.dk/eli/lta/2025/624/pdf>) |
| LBK nr. 1093 af 20/08/2023, lov om ophavsret | Kulturministeriet | <https://www.retsinformation.dk/api/pdf/238630> |
| Student intranet: exam rules, AI, copyright, code of conduct pages | EK | <https://mit.ek.dk/studiehaandbog/eksamensregler>, <https://mit.ek.dk/studiehaandbog/ai-kunstig-intelligens>, <https://mit.ek.dk/bibliotek/hjaelp-og-vejledning/ophavsret-kopiering-og-brug-af-billeder-paa-studiet>, <https://mit.ek.dk/studiehaandbog/ordensregler> |
| Exam catalogue entry "Bachelorprojekt 2025/2026", Webdevelopment, Cphbusiness Lyngby (4134302CL) | EK (former Cphbusiness) | <https://fag.cphbusiness.dk/course/4134302CL/2025-2026> |
| Curriculum for Web Development, approved 20 Aug 2022, edited 2023 (older, English) | Cphbusiness, now EK | <https://www.ek.dk/media/zecjiskj/studieordning_web_cba-curriculum_2022-rev-24.pdf> |

The PDFs were downloaded and searched in full for *ophavsret, rettighed, immateriel, ejer,
tilhører, offentliggør, publicer, fortrolig, licens, kildekode* (and the English equivalents in
the 2022 curriculum).

## Findings

### 1. Which rules apply

- **Documented.** EK's index lists one study regulation for the top-up programme and says it
  "Gælder for alle studerende, der er startet på webudvikling" ("applies to all students who have
  started web development"). (<https://www.ek.dk/om-os/love-og-regler>, checked 7 Nov 2026.)
- **Documented.** The study regulation names the exam order as one of its legal bases and points
  to EK's study and exam rules for the details: "Derudover gælder den senest offentliggjorte
  version af Erhvervsakademi Københavns eksamens- og studieregler" ("In addition, the most recently
  published version of EK's exam and study rules applies"), § 5.1. (Studieordning 2026, checked
  7 Nov 2026.)
- **Documented.** EK's index lists "BEK nr. 624 af 02/06/2025 (Eksamensbekendtgørelsen)" as the
  current exam order. (<https://www.ek.dk/om-os/love-og-regler>, checked 7 Nov 2026.)

### 2. The student owns the copyright (exam order § 49)

- **Documented.** BEK 624/2025, Kapitel 12 "Andre regler", § 49:

  > § 49. Den studerende har ophavsretten til produkter, der fremkommer som resultat af en eksamen
  > eller prøve, i henhold til reglerne i lov om ophavsret, jf. dog stk. 3.
  >
  > Stk. 2. Den studerende har tillige ejendomsretten til disse produkter mod betaling af
  > eventuelle udgifter til materialer, som er anvendt ved eksamen eller prøve, jf. dog stk. 3.
  > Hvis den studerende ikke gør ejendomsretten gældende inden for 2 måneder, efter at resultatet
  > af bedømmelsen er meddelt, overgår ejendomsretten til uddannelsesinstitutionen.
  >
  > Stk. 3. Hvis eksaminationsforløbet inddrager parter uden for institutionen, aftaler
  > institutionen, den studerende og tredjeparten, i hvilket omfang de under respekt af gældende
  > ophavsretlige regler er berettiget til at anvende de resultater, der fremkommer som et led i
  > forløbet, herunder om eventuelle oplysninger om tredjepartens forhold må offentliggøres.

  Translation: "§ 49. The student holds the copyright in products that result from an exam or
  test, in accordance with the copyright act, but see subsection 3. (2) The student also holds the
  property right in these products, against payment of any costs of materials used at the exam,
  but see subsection 3. If the student does not claim the property right within 2 months of being
  told the result, it passes to the institution. (3) If the exam process involves parties outside
  the institution, the institution, the student and the third party agree to what extent each may
  use the results, with respect for copyright law, including whether information about the third
  party's affairs may be published."

  (<https://www.retsinformation.dk/eli/lta/2025/624/pdf>, checked 7 Nov 2026.)

- **Documented.** § 22 makes oral exams public "jf. dog § 49, stk. 3" ("but see § 49(3)"), so the
  third-party agreement in § 49(3) is also the hook for a closed exam. (Same source.)
- **Inference.** Stk. 2 is about *ejendomsret* (property in the physical or delivered copy), which
  Danish law keeps separate from copyright (see § 53(2) below). It reads as covering the handed-in
  copy, not the right to license the code. EK keeping a copy does not by itself give EK any right
  to license the work.

### 3. What the copyright act gives the author

All from LBK nr. 1093 af 20/08/2023, marked "Gældende" (in force) on the printout dated
7 Nov 2026, with one later amendment listed (LOV nr. 676 af 11/06/2024 § 1); I did not check
whether that amendment touches the sections below.
(<https://www.retsinformation.dk/api/pdf/238630>, checked 7 Nov 2026.)

- **Documented.** § 1, stk. 1 and 3: "Den, som frembringer et litterært eller kunstnerisk værk, har
  ophavsret til værket" … "Værker i form af edb-programmer henregnes til litterære værker." ("Whoever
  creates a literary or artistic work holds the copyright in it" … "Works in the form of computer
  programs count as literary works.")
- **Documented.** § 2, stk. 1: copyright gives "eneret til at råde over værket ved at fremstille
  eksemplarer af det og ved at gøre det tilgængeligt for almenheden" ("the exclusive right to
  dispose of the work by making copies of it and making it available to the public").
- **Documented.** § 53, stk. 1–2: "Ophavsmanden kan … helt eller delvis overdrage sine rettigheder
  efter denne lov." "Overdragelse af eksemplarer indbefatter ikke overdragelse af ophavsretten."
  ("The author can transfer their rights under this act in whole or in part." "Transferring copies
  does not transfer the copyright.")
- **Documented.** § 59: copyright in a computer program made by an *employee* in the course of
  their work passes to the employer. (Same source.)
- **Documented.** § 6: a work with two or more authors whose contributions can't be separated is
  owned by them jointly.
- **Inference.** A licence is a partial transfer or permission under § 53, so the copyright holder
  is the one who can grant it. A student is not EK's employee, so § 59 does not move the copyright
  to EK. § 59 would matter only if code were written as someone's employee (for example during an
  internship or a job).

### 4. EK's own rules: nothing on licensing or publishing

- **Documented, by absence.** The 2026 study regulation's bachelor section (§ 5.4) covers learning
  goals, the problem statement and assessment only. It says the problem "formuleres af den
  studerende, eventuelt i samarbejde med en privat eller offentlig virksomhed. Institutionen
  godkender problemstillingen" ("is formulated by the student, possibly together with a private
  or public company. The institution approves the problem"). No text on rights, publication or
  confidentiality. (Studieordning 2026, checked 7 Nov 2026.)
- **Documented, by absence.** EK's study and exam rules (in force 1 Mar 2026) have no section on
  rights, publication or confidentiality. The table of contents runs from sign-up through exams to
  complaints and dispensations. (Checked 7 Nov 2026.)
- **Documented, by absence.** The "Love og regler" page has no text on IP, copyright, publication of
  student work or student rights to their work. (Checked 7 Nov 2026.)
- **Documented, by absence.** The bachelor project's exam catalogue entry (Cphbusiness Lyngby,
  2025/2026) gives the exam form, the page limits and external assessment, nothing on rights or
  code. No 2026/2027 version of that code exists in the catalogue yet ("Et fag/modul med den
  pågældende kode findes ikke i den foretrukne årgang"). (<https://fag.cphbusiness.dk/course/4134302CL/2025-2026>, checked 7 Nov 2026.)
- **Documented.** The older 2022 English curriculum refers to a document that is not public: "For
  more about the bachelor project examination, consult the manual on the bachelor project."
  (§ 5.4, checked 7 Nov 2026.)
- **Documented.** EK's student intranet search is JavaScript-rendered; its sitemap
  (<https://mit.ek.dk/sitemap.xml>, 788 URLs) has no page on student IP, licensing or publishing
  the bachelor project. The only IP item is a past EK Startup webinar on patents, trademarks and
  design rights (<https://mit.ek.dk/kalender/ip-rettigheder>). Teaching platforms (itslearning,
  Moodle) need a login and were not checked.

### 5. EK rules that touch publishing indirectly

- **Documented.** Plagiarism includes self-plagiarism. Exam order § 34, stk. 2, nr. 1: exam
  cheating includes when the student "plagierer, herunder genbruger egen tekst (selvplagiering)
  uden kildehenvisning og citationstegn" ("plagiarises, including reusing their own text
  (self-plagiarism) without a reference and quotation marks"). EK's rules § 9.7 list "at anvende
  eget tidligere bedømt arbejde uden henvisning (plagiat)" ("using one's own previously assessed
  work without a reference"). (Both checked 7 Nov 2026.)
- **Documented.** AI use is allowed unless the study regulation or assignment says otherwise, but
  must be referenced; unreferenced AI output handed in as one's own is cheating (EK rules § 9.8).
  The intranet adds: "du ikke må indtaste fx virksomhedshemmeligheder eller følsomme
  personoplysninger i et AI-system" ("you must not enter, e.g., trade secrets or sensitive personal
  data into an AI system"). (<https://mit.ek.dk/studiehaandbog/ai-kunstig-intelligens>, checked
  7 Nov 2026.)
- **Documented.** Material EK licenses for teaching can't leave EK. Images used under the
  academies' VISDA agreement "må kun bruges til undervisningsbrug og må ikke udveksles med andre
  end EK's studerende og ansatte" ("may only be used for teaching and must not be shared with
  anyone but EK's students and staff"); copies under the Tekst & Node agreement may be shared on
  EK's platforms "men ikke over mail eller på sociale medier" ("but not by email or on social
  media"). (<https://mit.ek.dk/bibliotek/hjaelp-og-vejledning/ophavsret-kopiering-og-brug-af-billeder-paa-studiet>, checked 7 Nov 2026.)
- **Inference.** A public repo is publication, so anything in it copied under EK's teaching
  licences (course slides, scanned book pages, VISDA images) would breach those terms, whatever
  licence the repo carries. A repo licence also can't cover content the student doesn't own.

### 6. Repo record relevant to the licence

- **Repo record.** `AGENTS.md`/`CLAUDE.md`: "a solo EK PBA Webudvikling bachelor project (Nov 2026
  to Jan 2027)". No company partner is named anywhere in the tracked docs (`git grep` over tracked
  Markdown for supervisor, *vejleder*, third-party and campus names, 7 Nov 2026).
- **Repo record.** ADR-0002, area 7, LICENSE row: "Chosen when the repo goes public, after checking
  EK's rules on student work. With none, all rights are reserved." Q7 is deferred to #38.
- **Repo record.** The repo already holds third-party content with its own licences:
  `.agents/licenses/addyosmani-agent-skills.LICENSE` and `.agents/licenses/mattpocock-skills.LICENSE`
  cover the vendored skills under `.agents/skills/`. (Outside EK's rules, but the chosen licence
  will sit next to them.)

## What the sources leave unclear

1. **Whether the code is a "product of the exam".** § 49 covers "produkter, der fremkommer som
   resultat af en eksamen eller prøve". It doesn't say whether that means only the handed-in report
   and artefacts, or also a repo developed before and after hand-in. Either way the student is the
   author under the copyright act § 1, so this matters mostly for § 49(2)–(3).
2. **Timing of publication.** No source says whether the project (code or report) may be public
   *before* the exam. Open points: whether EK's plagiarism check would flag the student's own
   public text or code as a match, and whether a public repo's history counts as "previously
   assessed work" in a later course (it does not seem to, since it isn't assessed until the exam).
3. **The bachelor project manual.** The 2022 curriculum refers to "the manual on the bachelor
   project", which isn't public. Its current EK version, if any, may say something on publication,
   confidentiality or code hand-in.
4. **Outside contributions.** No rule addresses pull requests or issues from people outside EK on a
   public exam repo. The exam order lists "ikke-tilladt samarbejde" (unauthorised collaboration)
   and "fortier eller vildleder om egen indsats" (concealing or misleading about one's own effort)
   as cheating (§ 34(2), nr. 3–4). Whether outside contributions before hand-in are allowed, and
   how to document them, is not addressed.
5. **AI-generated code.** The copyright act gives copyright to "den, som frembringer" (whoever
   creates) a work. Whether code mostly written by AI agents under the student's direction is
   protected at all, and so whether a licence on it has force, is not addressed by any EK source
   or by the act's text. EK only requires that AI use is referenced. (Inference: this is a general
   legal question, not an EK rule.)
6. **Censor access.** No source says whether the censor or supervisor must get access to the repo,
   or in what form code is handed in (Wiseflow upload, link, both).
7. **Exact exam order version at exam time.** BEK 624/2025 is the version EK lists today. If a new
   exam order takes effect before the January 2027 exam, § 49 should be re-checked.

None of these points changes who holds the copyright in code the student writes alone. They bear
on *when* to publish and what the repo may contain.

## Question to send to EK

The rules that settle ownership are public (exam order § 49 and the copyright act). EK's own
documents are silent on licensing and publishing, so this question asks EK to confirm the reading
and to answer the open points. Suggested recipient: the programme's study administration or the
bachelor project coordinator (via <https://mit.ek.dk/studiehaandbog/kontakt-ek>).

**Dansk:**

> Emne: Offentliggørelse af kode fra bachelorprojekt under en open source-licens
>
> Hej,
>
> Jeg skriver mit bachelorprojekt på PBA Webudvikling (november 2026 – januar 2027) alene og uden
> samarbejdsvirksomhed. Projektet er et browserspil, og koden ligger i et Git-repository, som jeg
> gerne vil gøre offentligt og udgive under en open source-licens.
>
> Efter eksamensbekendtgørelsens § 49 (BEK nr. 624 af 2. juni 2025) har jeg som studerende
> ophavsretten til produkter fra eksamen. Kan I bekræfte følgende:
>
> 1. At EK ikke har regler eller aftaler, der begrænser min ret til at offentliggøre koden og
>    udgive den under en licens, jeg selv vælger.
> 2. Om koden og/eller rapporten må være offentligt tilgængelig *før* aflevering og eksamen, og om
>    det kan give problemer med plagiatkontrollen (fx at min egen offentlige tekst eller kode
>    giver et match).
> 3. Om der findes en vejledning eller manual for bachelorprojektet på webudvikling, der siger noget
>    om offentliggørelse, fortrolighed eller aflevering af kode, og i så fald hvor jeg kan finde den.
> 4. Om det er tilladt, at personer uden for EK bidrager til et offentligt repository (fx med
>    fejlrapporter eller kodeforslag) før aflevering, og i så fald hvordan jeg skal dokumentere
>    det.
> 5. Hvordan censor og vejleder forventes at få adgang til koden (aflevering i Wiseflow, link til
>    repository eller begge dele).
>
> På forhånd tak.
>
> Venlig hilsen
> [navn, studienummer, hold]

**English:**

> Subject: Publishing my bachelor project's code under an open-source licence
>
> Hello,
>
> I am writing my bachelor project on the PBA in Web Development (November 2026 to January 2027)
> alone and without a partner company. The project is a browser game, and its code lives in a Git
> repository that I would like to make public and release under an open-source licence.
>
> Under section 49 of the exam order (BEK no. 624 of 2 June 2025), I as the student hold the
> copyright in products of the exam. Could you confirm the following:
>
> 1. That EK has no rules or agreements that limit my right to publish the code and release it
>    under a licence of my choice.
> 2. Whether the code and/or the report may be public *before* hand-in and the exam, and whether
>    that could cause problems with the plagiarism check (for example, my own public text or code
>    producing a match).
> 3. Whether there is a guide or manual for the web development bachelor project that says anything
>    about publication, confidentiality or handing in code, and if so where I can find it.
> 4. Whether people outside EK may contribute to a public repository (for example with bug reports
>    or code suggestions) before hand-in, and if so how I should document that.
> 5. How the censor and supervisor are expected to access the code (Wiseflow upload, a link to the
>    repository, or both).
>
> Thank you in advance.
>
> Kind regards,
> [name, student number, class]
