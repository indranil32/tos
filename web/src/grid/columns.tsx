import { CategoryChip, StatusBadge } from '../components/Badges';
import { CATEGORY_DOMAINS, CategoryDomainKey, STATUS_DOMAINS, StatusDomainKey } from '../theme/colors';
import { GridColumn } from './DataGrid';

type Opts<T> = Partial<GridColumn<T>>;

export const text = <T,>(id: string, header: string, value: (r: T) => unknown, o: Opts<T> = {}): GridColumn<T> =>
  ({ id, header, type: 'text', value, ...o });

export const num = <T,>(id: string, header: string, value: (r: T) => unknown, o: Opts<T> = {}): GridColumn<T> =>
  ({ id, header, type: 'number', value, align: 'right', ...o });

export const date = <T,>(id: string, header: string, value: (r: T) => unknown, o: Opts<T> = {}): GridColumn<T> =>
  ({ id, header, type: 'date', value, ...o });

export const bool = <T,>(id: string, header: string, value: (r: T) => unknown, o: Opts<T> = {}): GridColumn<T> =>
  ({ id, header, type: 'boolean', value, ...o });

/** Status column: badge from the colour source, life-cycle sort order, enum filter options. */
export const status = <T,>(id: string, header: string, domain: StatusDomainKey, value: (r: T) => unknown, o: Opts<T> = {}): GridColumn<T> => {
  const values = STATUS_DOMAINS[domain].values as Record<string, { label: string }>;
  return {
    id, header, type: 'enum', value,
    enumOptions: Object.entries(values).map(([v, d]) => ({ value: v, label: d.label })),
    enumOrder: Object.keys(values),
    renderValue: (v) => <StatusBadge domain={domain} value={v as string} />,
    ...o,
  };
};

/** Category column: outlined chip from the colour source. */
export const category = <T,>(id: string, header: string, domain: CategoryDomainKey, value: (r: T) => unknown, o: Opts<T> = {}): GridColumn<T> => {
  const values = CATEGORY_DOMAINS[domain].values as Record<string, { label: string }>;
  return {
    id, header, type: 'enum', value,
    enumOptions: Object.entries(values).map(([v, d]) => ({ value: v, label: d.label })),
    enumOrder: Object.keys(values),
    renderValue: (v) => <CategoryChip domain={domain} value={v as string} />,
    ...o,
  };
};

/** Plain enum column (values discovered from the data). */
export const enumCol = <T,>(id: string, header: string, value: (r: T) => unknown, options: string[], o: Opts<T> = {}): GridColumn<T> =>
  ({ id, header, type: 'enum', value, enumOptions: options.map((v) => ({ value: v, label: v })), ...o });
