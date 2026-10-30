import type { Profile, Organization } from "../../../packages/shared/src/index";
export { roles } from "../../../packages/shared/src/index";
export type {
  Project,
  Supplier,
  Profile,
  Organization,
} from "../../../packages/shared/src/index";
export type Account = {
  profile: Profile;
  organizations: Organization[];
  is_primary_admin?: boolean;
  mode?: string;
};
export type Invite = {
  id: string;
  email: string;
  role: string;
  project_id: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};
export type Collaborator = {
  user_id: string;
  role: string;
  supplier_id: string | null;
  active: boolean;
};
