import { createConfig } from '../utils/config';
import { createPrismaClient } from '../utils/prisma';

async function main() {
  const config = createConfig();

  if (config.IS_PRODUCTION || process.env.NODE_ENV === 'production') {
    throw new Error('Esecuzione del seed demo bloccata in ambiente di produzione.');
  }

  const prisma = createPrismaClient(config.DATABASE_URL);

  try {
    // Seed venue_demo_1 (fixture locale per sviluppo/test)
    const venue1 = await prisma.venue.upsert({
      where: { id: 'venue_demo_1' },
      update: {
        name: 'Demo Sauta Cloud (A-Cube)',
        acubeApiKey: 'acube_key_test_123',
        acubeOrganizationId: 'org_test_123',
        isActive: true,
      },
      create: {
        id: 'venue_demo_1',
        name: 'Demo Sauta Cloud (A-Cube)',
        acubeApiKey: 'acube_key_test_123',
        acubeOrganizationId: 'org_test_123',
        isActive: true,
      },
    });
    console.log(`Venue creata/aggiornata: ${venue1.name} (${venue1.id})`);

    // Upsert dominio platform verificato per la venue demo locale
    await prisma.venueDomain.upsert({
      where: { hostname: 'demo.localhost' },
      update: {
        venueId: venue1.id,
        type: 'PLATFORM',
        status: 'VERIFIED',
        isPrimary: true,
        verifiedAt: new Date(),
      },
      create: {
        venueId: venue1.id,
        hostname: 'demo.localhost',
        type: 'PLATFORM',
        status: 'VERIFIED',
        isPrimary: true,
        verifiedAt: new Date(),
      },
    });
    console.log(`Dominio platform associato: demo.localhost per ${venue1.id}`);

    const initialProducts = [
      { slug: 'vodka-redbull', name: 'Vodka Redbull', price: 1000 },
      { slug: 'gin-tonic', name: 'Gin Tonic', price: 1000 },
      { slug: 'negroni', name: 'Negroni', price: 800 },
      { slug: 'aperol-spritz', name: 'Aperol Spritz', price: 700 },
      { slug: 'mojito', name: 'Mojito', price: 900 },
      { slug: 'moscow-mule', name: 'Moscow Mule', price: 900 },
      { slug: 'cuba-libre', name: 'Cuba Libre', price: 800 },
    ];

    for (const p of initialProducts) {
      await prisma.product.upsert({
        where: {
          venueId_slug: {
            venueId: venue1.id,
            slug: p.slug,
          },
        },
        update: {
          price: p.price,
          name: p.name,
          active: true,
        },
        create: {
          venueId: venue1.id,
          slug: p.slug,
          name: p.name,
          price: p.price,
          active: true,
        },
      });
    }

    console.log('Seed completato con successo!');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
