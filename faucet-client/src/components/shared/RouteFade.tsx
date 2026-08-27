import React from 'react';
import { useLocation } from 'react-router';

/* Content-only route entrance, ported from hyperpools: the incoming page fades
 * in and rises 6px over 180ms (--ease-out), keyed on the pathname. No exit (an
 * exit would hold the old tree on a path hit dozens of times a session), the
 * masthead and footer stay put, and the very first paint is static. Reduced
 * motion keeps the fade and drops the rise (in the CSS). Pure CSS animation —
 * a one-shot entrance doesn't earn a motion library. */
export function RouteFade({ children }: { children: React.ReactNode }): React.ReactElement {
  const location = useLocation();
  const prevPath = React.useRef(location.pathname);
  const hasNavigated = React.useRef(false);

  if(location.pathname !== prevPath.current) {
    hasNavigated.current = true;
    prevPath.current = location.pathname;
  }

  React.useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <div key={location.pathname} className={"route-fade" + (hasNavigated.current ? " enter" : "")}>
      {children}
    </div>
  );
}
