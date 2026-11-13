import type {Metadata} from 'next';
import PortPlanner from '../../components/port-planner/port-planner';

export const metadata: Metadata = {title: 'История и проверка прогноза | План мощности'};

export default function Page() {
  return <PortPlanner view="history"/>;
}
