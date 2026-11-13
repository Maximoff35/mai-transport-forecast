import type {Metadata} from 'next';
import PortPlanner from '../../components/port-planner/port-planner';

export const metadata: Metadata = {title: 'Ретроспектива решений | План мощности'};

export default function Page() {
  return <PortPlanner view="replay"/>;
}
