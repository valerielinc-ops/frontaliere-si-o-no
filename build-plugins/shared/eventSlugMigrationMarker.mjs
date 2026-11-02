// Explicit declaration for the indexable event-slug migration bridges emitted
// by eventsSeoPagesPlugin.  REDIRECT_STUB_MARKER is shared by many bridge
// families; this marker lets the Bing frontier classifier require both the
// event migration emitter contract and the exact event-detail route shape.
export const EVENT_SLUG_MIGRATION_BRIDGE_MARKER = '<!--EVENT_SLUG_MIGRATION_BRIDGE-->';
