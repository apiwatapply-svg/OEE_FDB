'use client';

import { Component, type ReactNode, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ReportDashboard from '../components/ReportDashboard';

class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
    state = { error: null as Error | null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    render() {
        if (this.state.error) {
            return (
                <div style={{ padding: 16, color: '#b91c1c' }}>
                    <div style={{ fontWeight: 700 }}>Application error</div>
                    <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace' }}>
                        {this.state.error.message}
                        {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}

function MonthlyReportContent() {
    const searchParams = useSearchParams();
    const machineName = searchParams.get('machine') || '';
    return (
        <ReportDashboard
            mode="monthly"
            initialArea={searchParams.get('area') || ''}
            initialType={searchParams.get('type') || ''}
            initialMachine={machineName}
            initialModel={searchParams.get('model') || ''}
        />
    );
}

export default function MonthlyReportPage() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <PageErrorBoundary>
                <MonthlyReportContent />
            </PageErrorBoundary>
        </Suspense>
    );
}
