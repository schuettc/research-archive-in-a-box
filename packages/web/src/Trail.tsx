import { Link } from "react-router";

export type Step = { label: string; to?: string };

/** Where the page sits, above its title: each step a link back, the last the page itself. */
export function Trail({ steps }: { steps: Step[] }) {
  return (
    <nav aria-label="Breadcrumb" className="trail">
      <ol>
        {steps.map((step, index) => (
          <li key={index}>
            {step.to && index < steps.length - 1 ? (
              <Link to={step.to}>{step.label}</Link>
            ) : (
              <span aria-current="page">{step.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
