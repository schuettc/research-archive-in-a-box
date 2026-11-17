import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, Route, Routes, useLocation, useParams } from "react-router";
import { groups, signedInEmail, signIn, signOut, subscribe } from "./auth";
import { NavigatedContext, PageHeading, useTitle } from "./page";
import { About } from "./routes/About";
import { Account as AccountPage } from "./routes/Account";
import { Dataset } from "./routes/Dataset";
import { MySubmissions } from "./routes/MySubmissions";
import { Privacy } from "./routes/Privacy";
import { Review } from "./routes/Review";
import { ReviewQueue } from "./routes/ReviewQueue";
import { Search } from "./routes/Search";
import { People } from "./routes/People";
import { Settings } from "./routes/Settings";
import { AccessRequests } from "./routes/AccessRequests";
import { CorrectDetails } from "./routes/CorrectDetails";
import { Downloads } from "./routes/Downloads";
import { SignIn } from "./routes/SignIn";
import { Submission } from "./routes/Submission";
import { Submit } from "./routes/Submit";
import { BRAND, PUBLISHER } from "./site";
import { Trail, type Step } from "./Trail";

function NotFound() {
  useTitle("Not found");
  return (
    <>
      <PageHeading>Page not found</PageHeading>
      <div className="empty">
        <p className="lead">There's nothing at this address.</p>
        <p className="muted">The link may be old, or the dataset may have moved.</p>
        <p className="actions">
          <Link className="button primary" to="/">
            Search the archive
          </Link>
        </p>
      </div>
    </>
  );
}

/** `/datasets/<id>/v<n>`: React Router matches whole segments, so the `v` is read here. */
function VersionedDataset() {
  const { id = "", version = "" } = useParams();
  const match = /^v([1-9]\d*)$/.exec(version);
  if (!match) return <NotFound />;
  return <Dataset id={id} version={Number(match[1])} />;
}

/** `/datasets/<id>/v<n>/correct`: the version read as `VersionedDataset` reads it. */
function CorrectRoute() {
  const { id = "", version = "" } = useParams();
  const match = /^v([1-9]\d*)$/.exec(version);
  if (!match) return <NotFound />;
  return <CorrectDetails key={`${id}@${version}`} id={id} version={Number(match[1])} />;
}

function SubmissionRoute() {
  const { id = "" } = useParams();
  return <Submission key={id} id={id} />;
}

function ReviewRoute() {
  const { id = "" } = useParams();
  return <Review key={id} id={id} />;
}

function CurrentDataset() {
  const { id = "" } = useParams();
  return <Dataset id={id} />;
}

/**
 * The header's account slot, always in the same place: Sign in when no one is signed in, else
 * one Account button whose menu names the reader and offers their Account page and Sign out.
 */
function Account() {
  const email = useSyncExternalStore(subscribe, signedInEmail);
  const { pathname, search } = useLocation();
  const [open, setOpen] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const here = `${pathname}${search}`;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!slot.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  if (!email) {
    // The sign-in page is its own Sign in: the slot keeps its place, empty.
    return (
      <div className="account">
        {pathname !== "/sign-in" && (
          <button type="button" className="account-button" onClick={() => void signIn(here)}>
            Sign in
          </button>
        )}
      </div>
    );
  }

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div className="account" ref={slot}>
      <button
        ref={trigger}
        type="button"
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen(!open)}
      >
        Account <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          id="account-menu"
          className="account-menu"
          role="menu"
          aria-label="Account"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <p className="account-who">
            Signed in as <strong>{email}</strong>
          </p>
          <Link role="menuitem" to="/account" autoFocus onClick={() => setOpen(false)}>
            Account
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

type Role = "contributor" | "curator" | "admin";

/** A menu item: where it leads, and the paths it is current on. */
type Item = { to: string; label: string; on: string[] };

const PUBLIC: Item[] = [
  { to: "/", label: "Browse", on: ["/", "/datasets"] },
  { to: "/about", label: "About the archive", on: ["/about"] },
];

/** The signed-in areas, in the order the nav lists them, each with the group it needs. */
const AREAS: (Item & { role: Role })[] = [
  {
    role: "contributor",
    to: "/submissions",
    label: "Submissions",
    on: ["/submissions", "/submit"],
  },
  { role: "curator", to: "/review", label: "Review", on: ["/review"] },
  { role: "admin", to: "/settings", label: "Settings", on: ["/settings"] },
];

function isCurrent(item: Item, pathname: string): boolean {
  return item.on.some((path) =>
    path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`),
  );
}

/** The areas the signed-in reader's groups allow. */
function useAreas(): Item[] {
  const email = useSyncExternalStore(subscribe, signedInEmail);
  const mine = useSyncExternalStore(subscribe, groups);
  return email ? AREAS.filter((area) => mine.includes(area.role)) : [];
}

function ItemLink({ item, onClick }: { item: Item; onClick?: () => void }) {
  const { pathname } = useLocation();
  return (
    <Link
      to={item.to}
      aria-current={isCurrent(item, pathname) ? "page" : undefined}
      onClick={onClick}
    >
      {item.label}
    </Link>
  );
}

/**
 * The nav: Browse and About in their own slot, then the areas the reader's groups allow. The
 * nav keeps one width whatever it lists, so its left edge, its first links and the Account
 * button beside it never move when areas appear.
 */
function MainNav() {
  const areas = useAreas();
  return (
    <nav aria-label="Main" className="nav">
      <div className="nav-public">
        {PUBLIC.map((item) => (
          <ItemLink key={item.to} item={item} />
        ))}
      </div>
      <div className="nav-areas">
        {areas.map((area) => (
          <ItemLink key={area.to} item={area} />
        ))}
      </div>
    </nav>
  );
}

/**
 * The phone's header: one Menu button opening a panel with every menu item, who is signed in,
 * Account and Sign out (or Sign in). Escape and the button close it, and focus returns to the
 * button. The stylesheet shows it only at phone width.
 */
function PhoneMenu({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, setOpen]);
  return (
    <button
      ref={button}
      type="button"
      className="menu-button"
      aria-expanded={open}
      aria-controls="menu-panel"
      onClick={() => setOpen(!open)}
    >
      {open ? "Close" : "Menu"}
    </button>
  );
}

function MenuPanel({ close }: { close: () => void }) {
  const email = useSyncExternalStore(subscribe, signedInEmail);
  const areas = useAreas();
  const { pathname, search } = useLocation();
  return (
    <nav id="menu-panel" className="menu-panel" aria-label="Menu">
      {[...PUBLIC, ...areas].map((item) => (
        <ItemLink key={item.to} item={item} onClick={close} />
      ))}
      {email ? (
        <>
          <p className="who">
            Signed in as <strong>{email}</strong>
          </p>
          <Link to="/account" onClick={close}>
            Account
          </Link>
          <button
            type="button"
            onClick={() => {
              close();
              void signOut();
            }}
          >
            Sign out
          </button>
        </>
      ) : (
        pathname !== "/sign-in" && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              close();
              void signIn(`${pathname}${search}`);
            }}
          >
            Sign in
          </button>
        )
      )}
    </nav>
  );
}

/** What a gate says to a signed-out reader: what to do, who can see it, and the trail. */
type Locked = { heading: string; who: string; trail?: Step[] };

/** What an area's page says when the reader can't use it: what to do, then why. */
function Gate({
  heading,
  title,
  role,
  email,
  locked,
}: {
  heading: string;
  title: string;
  role: Role | Role[];
  email: string | null;
  locked: Locked;
}) {
  useTitle(title);
  const roles = Array.isArray(role) ? role : [role];
  const { pathname, search } = useLocation();
  const areas = useAreas();
  if (!email) {
    return (
      <div className="prose">
        {locked.trail && <Trail steps={locked.trail} />}
        <PageHeading>{locked.heading}</PageHeading>
        <div className="callout">
          <p>{locked.who}</p>
          <p className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => void signIn(`${pathname}${search}`)}
            >
              Sign in
            </button>
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="prose">
      <PageHeading>{heading}</PageHeading>
      <div className="callout">
        <p>
          This page needs the {roles.join(" or ")} role, and your account ({email}) doesn't have it.{" "}
          {BRAND.contact ? (
            <>
              Ask the archive's admin at <a href={`mailto:${BRAND.contact}`}>{BRAND.contact}</a> to
              add it.
            </>
          ) : (
            "Ask the archive's admin to add it."
          )}
        </p>
        <p className="gate-can">
          <b>What you can use</b>
        </p>
        <p className="actions">
          {areas.map((area) => (
            <Link key={area.to} className="button" to={area.to}>
              {area.label}
            </Link>
          ))}
          <Link className="button" to="/">
            Browse the archive
          </Link>
        </p>
      </div>
    </div>
  );
}

/** A signed-in area: its page for a reader in `role` (or any of a list), else what to do, or why not. */
function Area({
  role,
  heading,
  title,
  locked,
  children,
}: {
  role: Role | Role[];
  heading: string;
  title: string;
  locked: Locked;
  children: ReactNode;
}) {
  const email = useSyncExternalStore(subscribe, signedInEmail);
  const mine = useSyncExternalStore(subscribe, groups);
  const roles = Array.isArray(role) ? role : [role];
  if (!email || !roles.some((r) => mine.includes(r))) {
    return <Gate heading={heading} title={title} role={role} email={email} locked={locked} />;
  }
  return children;
}

const SUBMISSIONS_WHO =
  "Submissions are private to the people who sent them and the archive's curators.";
const REVIEW_WHO = "The review queue is for the archive's curators.";
const SETTINGS_LOCKED: Locked = {
  heading: "Sign in to change the settings",
  who: "The settings are for the archive's admins.",
};

function Masthead() {
  const { pathname } = useLocation();
  const [menu, setMenu] = useState({ open: false, path: pathname });
  // Moving to another page closes the phone's menu.
  const open = menu.open && menu.path === pathname;
  const setOpen = (next: boolean) => setMenu({ open: next, path: pathname });
  return (
    <header className="masthead">
      <div className="inner">
        <Link className="mark" to="/">
          {BRAND.logo && <img src={BRAND.logo} alt="" width="44" height="44" />}
          <span className="name">{BRAND.name}</span>
        </Link>
        <MainNav />
        <Account />
        <PhoneMenu open={open} setOpen={setOpen} />
      </div>
      {open && <MenuPanel close={() => setOpen(false)} />}
    </header>
  );
}

export function AppRoutes() {
  // Focus moves to each new page's h1, but not on the page the reader arrived at.
  const { pathname } = useLocation();
  const [seen, setSeen] = useState({ path: pathname, moved: false });
  if (seen.path !== pathname) setSeen({ path: pathname, moved: true });
  const navigated = seen.moved || seen.path !== pathname;

  return (
    <NavigatedContext value={navigated}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Masthead />
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Search />} />
          <Route path="/about" element={<About />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/datasets/:id" element={<CurrentDataset />} />
          <Route path="/datasets/:id/:version" element={<VersionedDataset />} />
          <Route
            path="/datasets/:id/:version/correct"
            element={
              <Area
                role={["curator", "admin"]}
                heading="Correct details"
                title="Correct details"
                locked={{
                  heading: "Sign in to correct this dataset",
                  who: "Correcting a published dataset's details is for the archive's curators and admins.",
                }}
              >
                <CorrectRoute />
              </Area>
            }
          />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/account" element={<AccountPage />} />
          <Route
            path="/submit"
            element={
              <Area
                role="contributor"
                heading="Submit a package"
                title="Submit"
                locked={{
                  heading: "Sign in to submit a package",
                  who: "Contributors send packages here for a curator to review.",
                  trail: [
                    { label: "Submissions", to: "/submissions" },
                    { label: "Submit a package" },
                  ],
                }}
              >
                <Submit />
              </Area>
            }
          />
          <Route
            path="/submissions"
            element={
              <Area
                role="contributor"
                heading="Submissions"
                title="Submissions"
                locked={{ heading: "Sign in to see your submissions", who: SUBMISSIONS_WHO }}
              >
                <MySubmissions />
              </Area>
            }
          />
          <Route
            path="/submissions/:id"
            element={
              <Area
                role="contributor"
                heading="Submission"
                title="Submission"
                locked={{
                  heading: "Sign in to see this submission",
                  who: SUBMISSIONS_WHO,
                  trail: [{ label: "Submissions", to: "/submissions" }, { label: "A submission" }],
                }}
              >
                <SubmissionRoute />
              </Area>
            }
          />
          <Route
            path="/review"
            element={
              <Area
                role="curator"
                heading="Review queue"
                title="Review queue"
                locked={{ heading: "Sign in to see the review queue", who: REVIEW_WHO }}
              >
                <ReviewQueue />
              </Area>
            }
          />
          <Route
            path="/review/:id"
            element={
              <Area
                role="curator"
                heading="Review"
                title="Review"
                locked={{
                  heading: "Sign in to review this submission",
                  who: REVIEW_WHO,
                  trail: [{ label: "Review queue", to: "/review" }, { label: "A submission" }],
                }}
              >
                <ReviewRoute />
              </Area>
            }
          />
          <Route
            path="/settings"
            element={
              <Area role="admin" heading="Settings" title="Settings" locked={SETTINGS_LOCKED}>
                <Settings />
              </Area>
            }
          />
          <Route
            path="/settings/people"
            element={
              <Area role="admin" heading="Settings" title="People" locked={SETTINGS_LOCKED}>
                <People />
              </Area>
            }
          />
          <Route
            path="/settings/access"
            element={
              <Area
                role="admin"
                heading="Settings"
                title="Access requests"
                locked={SETTINGS_LOCKED}
              >
                <AccessRequests />
              </Area>
            }
          />
          <Route
            path="/settings/downloads"
            element={
              <Area role="admin" heading="Settings" title="Downloads" locked={SETTINGS_LOCKED}>
                <Downloads />
              </Area>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <footer className="footer">
        <div className="inner">
          {PUBLISHER} · Data are shared under the licence shown on each dataset.
          {BRAND.contact && (
            <>
              {" "}
              Contact <a href={`mailto:${BRAND.contact}`}>{BRAND.contact}</a>.
            </>
          )}{" "}
          · <Link to="/privacy">Privacy</Link>
        </div>
      </footer>
    </NavigatedContext>
  );
}
