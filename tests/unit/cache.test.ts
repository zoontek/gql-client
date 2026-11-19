import { expect, test } from "bun:test";

import type { Connection } from "../../src";
import { ClientCache } from "../../src/cache/cache";
import { transformDocument } from "../../src/graphql/transform";
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

const preparedAppQuery = transformDocument(appQuery);
const appVariables = { id: "1" };

const identificationLevels = {
  __typename: "IdentificationLevels",
  expert: true,
  PVID: true,
  QES: true,
} as const;

test("writes a query, then mutation results that update its entities", () => {
  const cache = new ClientCache({ interfaceToTypes: {} });
  const preparedMutation = transformDocument(bindAccountMembershipMutation);
  const mutationVariables = { id: "account-membership-2" };

  const initialResponse = getAppQueryResponse({
    user2LastName: "Last",
    user1IdentificationLevels: null,
  });

  cache.writeOperation(preparedAppQuery, initialResponse, appVariables);

  expect(cache.dump()).toMatchSnapshot();
  expect(cache.readOperation(preparedAppQuery, appVariables)).toMatchObject(
    initialResponse,
  );

  // A rejection payload doesn't touch the membership.
  cache.writeOperation(
    preparedMutation,
    bindMembershipMutationRejectionResponse,
    mutationVariables,
  );

  expect(cache.readOperation(preparedAppQuery, appVariables)).toMatchObject(
    initialResponse,
  );

  cache.writeOperation(
    preparedMutation,
    bindMembershipMutationSuccessResponse,
    mutationVariables,
  );

  expect(cache.dump()).toMatchSnapshot();
  expect(cache.readOperation(preparedAppQuery, appVariables)).toMatchObject(
    getAppQueryResponse({
      user2LastName: "Acthernoene",
      user1IdentificationLevels: null,
    }),
  );

  const updatedResponse = getAppQueryResponse({
    user2LastName: "Acthernoene",
    user1IdentificationLevels: identificationLevels,
  });

  cache.writeOperation(preparedAppQuery, updatedResponse, appVariables);

  expect(cache.dump()).toMatchSnapshot();
  expect(cache.readOperation(preparedAppQuery, appVariables)).toMatchObject(
    updatedResponse,
  );
});

test("writes and reads fragments on interfaces from the schema config", () => {
  const cache = new ClientCache({
    interfaceToTypes: {
      OnboardingStatusInfo: [
        "OnboardingInvalidStatusInfo",
        "OnboardingFinalizedStatusInfo",
        "OnboardingValidStatusInfo",
      ],
    },
  });

  const preparedOnboardingInfo = transformDocument(OnboardingInfo);
  const variables = {
    id: "d26ed1ed-5f70-4096-9d8e-27ef258e26fa",
    language: "en",
  };

  cache.writeOperation(
    preparedOnboardingInfo,
    onboardingInfoResponse,
    variables,
  );

  expect(cache.dump()).toMatchSnapshot();
  expect(cache.readOperation(preparedOnboardingInfo, variables)).toMatchObject(
    onboardingInfoResponse,
  );
});

test("reads queries that select fewer or more fields, and updates a connection", () => {
  type Membership = {
    __typename: "AccountMembership";
    id: string;
    account: { __typename: "Account"; name: string };
    membershipUser: { __typename: "User"; id: string; lastName: string };
  };

  const membership = (index: number): Membership => ({
    __typename: "AccountMembership",
    id: `account-membership-${index}`,
    account: { __typename: "Account", name: "First" },
    membershipUser: {
      __typename: "User",
      id: `user-${index}`,
      lastName: "Le Brun",
    },
  });

  const cache = new ClientCache({ interfaceToTypes: {} });
  const preparedAddMembership = transformDocument(addMembership);

  cache.writeOperation(
    preparedAppQuery,
    getAppQueryResponse({
      user2LastName: "Last",
      user1IdentificationLevels: null,
    }),
    appVariables,
  );

  expect(cache.readOperation(appQueryWithoutMoreAccountInfo, {})).toBeDefined();
  expect(cache.readOperation(appQueryWithMoreAccountInfo, {})).toBeUndefined();

  const read = cache.readOperation(preparedAppQuery, appVariables) as
    | { accountMemberships: Connection<Membership> }
    | undefined;

  expect(read).toBeDefined();
  const accountMemberships = read?.accountMemberships;

  cache.updateConnection(accountMemberships, {
    remove: ["account-membership-1"],
  });

  for (const index of [3, 0]) {
    cache.writeOperation(
      preparedAddMembership,
      {
        __typename: "Mutation",
        addMembership: {
          __typename: "AddMembership",
          membership: membership(index),
        },
      },
      {},
    );
  }

  cache.updateConnection(accountMemberships, {
    append: [{ __typename: "AccountMembershipEdge", node: membership(3) }],
  });
  cache.updateConnection(accountMemberships, {
    prepend: [{ __typename: "AccountMembershipEdge", node: membership(0) }],
  });

  expect(cache.readOperation(preparedAppQuery, appVariables)).toMatchSnapshot();
});

test("reads back a response with fragments on interfaces as written", () => {
  const cache = new ClientCache({
    interfaceToTypes: {
      ProjectSettings: ["LiveProjectSettings", "SandboxProjectSettings"],
    },
  });

  const preparedBrandingQuery = transformDocument(brandingQuery);
  const variables = { id: "64060573-f0ec-4204-ad49-a3983497ada4" };

  cache.writeOperation(preparedBrandingQuery, brandingResponse, variables);

  expect(cache.readOperation(preparedBrandingQuery, variables)).toEqual(
    brandingResponse,
  );
});
