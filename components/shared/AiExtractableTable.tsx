interface TableColumn {
 header: string;
 accessor: string;
}

interface AiExtractableTableProps {
 caption: string;
 columns: TableColumn[];
 rows: Record<string, string>[];
 source?: string;
 className?: string;
}

export default function AiExtractableTable({ caption, columns, rows, source, className = '' }: AiExtractableTableProps) {
 return (
 <div className={`overflow-x-auto ${className}`} data-speakable>
 <table className="w-full border-collapse text-sm">
 <caption className="text-left text-base font-bold text-heading mb-3">{caption}</caption>
 <thead>
 <tr className="bg-surface-raised">
 {columns.map(col => (
 <th key={col.accessor} className="text-left px-4 py-2.5 font-semibold text-body border-b border-edge">
 {col.header}
 </th>
 ))}
 </tr>
 </thead>
 <tbody>
 {rows.map((row, i) => (
 <tr key={i} className={i % 2 === 0 ? 'bg-surface' : 'bg-surface-alt/50'}>
 {columns.map(col => (
 <td key={col.accessor} className="px-4 py-2.5 text-body border-b border-edge">
 {row[col.accessor]}
 </td>
 ))}
 </tr>
 ))}
 </tbody>
 </table>
 {source && (
 <p className="mt-2 text-xs text-muted">Fonte: {source}</p>
 )}
 </div>
 );
}
