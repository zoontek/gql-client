import { expect, test } from "bun:test";
import type { Connection } from "../src";
import { ClientCache } from "../src/cache";
import { transformDocument } from "../src/graphql/transformDocument";
import {
  OnboardingInfo,
  addMembership,
  appQuery,
  appQueryWithMoreAccountInfo,
  appQueryWithoutMoreAccountInfo,
  bindAccountMembershipMutation,
  bindMembershipMutationRejectionResponse,
  bindMembershipMutationSuccessResponse,
  brandingQuery,
  brandingResponse,
  getAppQueryResponse,
  onboardingInfoResponse,
} from "./data";

test("Write & read in cache", () => {
  const cache = new ClientCache({ interfaceToTypes: {} });

  const preparedAppQuery = transformDocument(appQuery);

  cache.writeOperation(
    preparedAppQuery,
    getAppQueryResponse({
      user2LastName: "Last",
      user1IdentificationLevels: null,
    }),
    {
      id: "1",
    },
  );

  expect(cache.dump()).toMatchSnapshot();

  expect(
    cache.readOperation(preparedAppQuery, {
      id: "1",
    }),
  ).toMatchObject(
    getAppQueryResponse({
      user2LastName: "Last",
      user1IdentificationLevels: null,
    }),
  );

  const preparedOnboardingInfo = transformDocument(OnboardingInfo);

  const preparedBindAccountMembershipMutation = transformDocument(
    bindAccountMembershipMutation,
  );

  cache.writeOperation(
    preparedBindAccountMembershipMutation,
    bindMembershipMutationRejectionResponse,
    {
      id: "account-membership-2",
    },
  );

  expect(
    cache.readOperation(preparedAppQuery, {
      id: "1",
    }),
  ).toMatchObject(
    getAppQueryResponse({
      user2LastName: "Last",
      user1IdentificationLevels: null,
    }),
  );

  cache.writeOperation(
    preparedBindAccountMembershipMutation,
    bindMembershipMutationSuccessResponse,
    {
      id: "account-membership-2",
    },
  );

  expect(cache.dump()).toMatchSnapshot();

  expect(
    cache.readOperation(preparedAppQuery, {
      id: "1",
    }),
  ).toMatchObject(
    getAppQueryResponse({
      user2LastName: "Acthernoene",
      user1IdentificationLevels: null,
    }),
  );

  cache.writeOperation(
    preparedAppQuery,
    getAppQueryResponse({
      user2LastName: "Acthernoene",
      user1IdentificationLevels: {
        __typename: "IdentificationLevels",
        expert: true,
        PVID: true,
        QES: true,
      },
    }),
    {
      id: "1",
    },
  );

  expect(cache.dump()).toMatchSnapshot();

  expect(
    cache.readOperation(preparedAppQuery, {
      id: "1",
    }),
  ).toMatchObject(
    getAppQueryResponse({
      user2LastName: "Acthernoene",
      user1IdentificationLevels: {
        __typename: "IdentificationLevels",
        expert: true,
        PVID: true,
        QES: true,
      },
    }),
  );

  const a = cache.readOperation(preparedAppQuery, {
    id: "1",
  });
  const b = cache.readOperation(preparedAppQuery, {
    id: "1",
  });

  expect(a).toBeDefined();
  expect(a).toBe(b);

  const cache2 = new ClientCache({ interfaceToTypes: {} });

  cache2.writeOperation(preparedOnboardingInfo, onboardingInfoResponse, {
    id: "d26ed1ed-5f70-4096-9d8e-27ef258e26fa",
    language: "en",
  });

  expect(cache2.dump()).toMatchSnapshot();

  expect(
    cache2.readOperation(preparedOnboardingInfo, {
      id: "d26ed1ed-5f70-4096-9d8e-27ef258e26fa",
      language: "en",
    }),
  ).toMatchObject(onboardingInfoResponse);

  const cache3 = new ClientCache({ interfaceToTypes: {} });

  cache3.writeOperation(
    preparedAppQuery,
    getAppQueryResponse({
      user2LastName: "Last",
      user1IdentificationLevels: null,
    }),
    {
      id: "1",
    },
  );

  const read = cache3.readOperation(preparedAppQuery, {
    id: "1",
  });

  expect(
    cache3.readOperation(appQueryWithoutMoreAccountInfo, {}),
  ).toBeDefined();

  expect(cache3.readOperation(appQueryWithMoreAccountInfo, {})).toBeUndefined();

  if (read !== undefined) {
    {
      const value = read as ReturnType<typeof getAppQueryResponse>;
      const accountMemberships =
        value.accountMemberships as unknown as Connection<{
          __typename: "AccountMembership";
          id: string;
          account: {
            __typename: "Account";
            name: string;
          };
          membershipUser: {
            __typename: "User";
            id: string;
            lastName: string;
          };
        }>;
      cache3.updateConnection(accountMemberships, {
        remove: ["account-membership-1"],
      });

      cache3.writeOperation(
        transformDocument(addMembership),
        {
          __typename: "Mutation",
          addMembership: {
            __typename: "AddMembership",
            membership: {
              __typename: "AccountMembership",
              id: "account-membership-3",
              account: {
                __typename: "Account",
                name: "First",
              },
              membershipUser: {
                __typename: "User",
                id: "user-3",
                lastName: "Le Brun",
              },
            },
          },
        },
        {},
      );

      cache3.writeOperation(
        transformDocument(addMembership),
        {
          __typename: "Mutation",
          addMembership: {
            __typename: "AddMembership",
            membership: {
              __typename: "AccountMembership",
              id: "account-membership-0",
              account: {
                __typename: "Account",
                name: "First",
              },
              membershipUser: {
                __typename: "User",
                id: "user-0",
                lastName: "Le Brun",
              },
            },
          },
        },
        {},
      );

      cache3.updateConnection(accountMemberships, {
        append: [
          {
            __typename: "AccountMembershipEdge",
            node: {
              __typename: "AccountMembership",
              id: "account-membership-3",
              account: {
                __typename: "Account",
                name: "First",
              },
              membershipUser: {
                __typename: "User",
                id: "user-3",
                lastName: "Le Brun",
              },
            },
          },
        ],
      });
      cache3.updateConnection(accountMemberships, {
        prepend: [
          {
            __typename: "AccountMembershipEdge",
            node: {
              __typename: "AccountMembership",
              id: "account-membership-0",
              account: {
                __typename: "Account",
                name: "First",
              },
              membershipUser: {
                __typename: "User",
                id: "user-0",
                lastName: "Le Brun",
              },
            },
          },
        ],
      });
    }

    expect(
      cache3.readOperation(preparedAppQuery, {
        id: "1",
      }),
    ).toMatchSnapshot();
  } else {
    expect(true).toBe(false);
  }

  const preparedBrandingQuery = transformDocument(brandingQuery);

  const cache4 = new ClientCache({
    interfaceToTypes: {
      ProjectSettings: ["LiveProjectSettings", "SandboxProjectSettings"],
    },
  });

  cache4.writeOperation(preparedBrandingQuery, brandingResponse, {
    id: "64060573-f0ec-4204-ad49-a3983497ada4",
  });

  expect(
    cache4.readOperation(preparedBrandingQuery, {
      id: "64060573-f0ec-4204-ad49-a3983497ada4",
    }),
  ).toEqual(brandingResponse);
});
