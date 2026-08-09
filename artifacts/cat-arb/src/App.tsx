import { useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, useLocation, Redirect } from 'wouter';
import { AppLayout } from '@/components/layout/app-layout';
import { ErrorBoundary } from '@/components/error-boundary';
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';

import Dashboard from '@/pages/dashboard';
import Trades from '@/pages/trades';
import Settings from '@/pages/settings';

const queryClient = new QueryClient();

// REQUIRED — canonical Clerk wiring (works in dev and prod; do not gate on env).
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

// Paper-terminal aesthetic: white card, near-black text, Butter orange primary.
const clerkAppearance = {
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: 'hsl(24 100% 50%)',
    colorForeground: 'hsl(0 0% 10%)',
    colorMutedForeground: 'hsl(0 0% 45%)',
    colorDanger: 'hsl(0 84% 60%)',
    colorBackground: 'hsl(0 0% 100%)',
    colorInput: 'hsl(0 0% 98%)',
    colorInputForeground: 'hsl(0 0% 10%)',
    colorNeutral: 'hsl(0 0% 20%)',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    borderRadius: '0.5rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-white border border-[hsl(0_0%_85%)] rounded-2xl w-[440px] max-w-full overflow-hidden shadow-sm',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[hsl(0_0%_10%)] font-bold',
    headerSubtitle: 'text-[hsl(0_0%_45%)]',
    socialButtonsBlockButtonText: 'text-[hsl(0_0%_10%)] font-medium',
    formFieldLabel: 'text-[hsl(0_0%_10%)] font-medium',
    footerActionLink: 'text-[hsl(24_100%_40%)] font-semibold hover:text-[hsl(24_100%_50%)]',
    footerActionText: 'text-[hsl(0_0%_45%)]',
    dividerText: 'text-[hsl(0_0%_45%)]',
    identityPreviewEditButton: 'text-[hsl(24_100%_40%)]',
    formFieldSuccessText: 'text-[hsl(142_71%_40%)]',
    alertText: 'text-[hsl(0_0%_10%)]',
    logoBox: 'justify-center',
    logoImage: 'h-12 w-12 rounded-lg',
    socialButtonsBlockButton: 'border border-[hsl(0_0%_85%)] bg-white hover:bg-[hsl(0_0%_96%)]',
    formButtonPrimary: 'bg-[hsl(24_100%_50%)] hover:bg-[hsl(24_100%_45%)] text-white font-semibold',
    formFieldInput: 'bg-[hsl(0_0%_98%)] border-[hsl(0_0%_85%)] text-[hsl(0_0%_10%)]',
    footerAction: 'justify-center',
    dividerLine: 'bg-[hsl(0_0%_85%)]',
    alert: 'border border-[hsl(0_0%_85%)] bg-[hsl(0_0%_98%)]',
    otpCodeFieldInput: 'border-[hsl(0_0%_85%)] text-[hsl(0_0%_10%)]',
    formFieldRow: 'gap-2',
    main: 'gap-5',
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

/** Public landing for signed-out visitors — never expose trading data or
 * auto-redirect to sign-in. Signed-in users go straight to the dashboard. */
function Landing() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <img src={`${basePath}/logo.svg`} alt="CAT ARB" className="h-16 w-16 rounded-xl" />
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">CAT Arbitrage Dashboard</h1>
        <p className="mt-2 max-w-md text-muted-foreground">
          Live cross-exchange arbitrage scanning and execution. Sign in to access the trading terminal.
        </p>
      </div>
      <div className="flex gap-3">
        <a
          href={`${basePath}/sign-in`}
          className="rounded-lg bg-primary px-6 py-2.5 font-semibold text-primary-foreground hover:opacity-90"
          data-testid="link-sign-in"
        >
          Sign in
        </a>
        <a
          href={`${basePath}/sign-up`}
          className="rounded-lg border border-border px-6 py-2.5 font-semibold text-foreground hover:bg-muted"
          data-testid="link-sign-up"
        >
          Create account
        </a>
      </div>
    </div>
  );
}

function HomeGate() {
  return (
    <>
      <Show when="signed-in">
        <AppLayout>
          <ErrorBoundary label="Dashboard">
            <Dashboard />
          </ErrorBoundary>
        </AppLayout>
      </Show>
      <Show when="signed-out">
        <Landing />
      </Show>
    </>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-in">
        <AppLayout>{children}</AppLayout>
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

// Clears cached (potentially sensitive) query data when the signed-in user changes.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: 'Welcome back',
            subtitle: 'Sign in to your trading terminal',
          },
        },
        signUp: {
          start: {
            title: 'Create your account',
            subtitle: 'Set up access to the CAT Arbitrage Dashboard',
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Switch>
            <Route path="/" component={HomeGate} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route path="/trades">
              <Protected><Trades /></Protected>
            </Route>
            <Route path="/settings">
              <Protected><Settings /></Protected>
            </Route>
            <Route component={NotFound} />
          </Switch>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
