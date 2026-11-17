import { PageHeading, useTitle } from "../page";
import { BRAND } from "../site";

/** The operator's `brand.privacy`: plain text, one paragraph per blank-line-separated block. */
function OperatorText({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>);
}

/** The kit's default, filled from the brand's name and contact. */
function DefaultText() {
  return (
    <>
      <p className="lede">What {BRAND.name} keeps about the people who use it, and why.</p>

      <h2>Reading and downloading</h2>
      <p>
        You can browse and download public datasets without an account. The site's delivery network
        logs each request, including your IP address, so the archive can count downloads. Those logs
        are deleted after 90 days; the counts are kept without addresses.
      </p>

      <h2>Accounts</h2>
      <p>
        If you create an account, the archive keeps your email address and the name you give, so it
        can sign you in and tell you about your submissions and requests. A new account can't do
        anything until an admin gives it a role.
      </p>

      <h2>Submitting data and asking for access</h2>
      <ul>
        <li>A dataset you submit is kept with your name as its contributor.</li>
        <li>
          When you ask for a restricted dataset, your request and the reason you give go to the
          archive's admins.
        </li>
      </ul>

      <h2>Questions and deletion</h2>
      <p>
        {BRAND.contact ? (
          <>
            To see, correct or delete what the archive holds about you, write to{" "}
            <a href={`mailto:${BRAND.contact}`}>{BRAND.contact}</a>.
          </>
        ) : (
          "To see, correct or delete what the archive holds about you, ask the archive's admins."
        )}
      </p>

      <p className="note">
        This page is the kit's default. The archive's operator can replace it with their own text by
        setting <code>brand.privacy</code> in <code>archive.yaml</code>.
      </p>
    </>
  );
}

/** `/privacy`: what the archive keeps about the people who use it, the operator's text or the kit's. */
export function Privacy() {
  useTitle("Privacy");
  return (
    <div className="prose">
      <PageHeading>Privacy</PageHeading>
      {BRAND.privacy ? <OperatorText text={BRAND.privacy} /> : <DefaultText />}
    </div>
  );
}
